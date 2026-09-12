import { randomInt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis, type Redis } from '@tps/queue';

import { LocalSmsSender, PhoneVerificationService } from './phone-verification.js';

class FakeRedis {
  private readonly values = new Map<string, string>();
  private readonly ttls = new Map<string, number>();

  set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    const exIndex = args.indexOf('EX');
    if (exIndex >= 0) this.ttls.set(key, Number(args[exIndex + 1]));
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  del(key: string): Promise<number> {
    this.ttls.delete(key);
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  eval(
    _script: string,
    _count: number,
    key: string,
    expected: string,
    next: string,
  ): Promise<number> {
    if (this.values.get(key) !== expected) return Promise.resolve(0);
    if (next === '') {
      this.values.delete(key);
      this.ttls.delete(key);
    } else {
      this.values.set(key, next);
    }
    return Promise.resolve(1);
  }

  ttl(key: string): Promise<number> {
    return Promise.resolve(this.ttls.get(key) ?? -2);
  }
}

const redisUrl = process.env['REDIS_URL'];
const describeIntegration = redisUrl === undefined ? describe.skip : describe;

describeIntegration('手机验证码原子核销（真实 Redis）', () => {
  let redis: Redis;
  let phone: string;
  let service: PhoneVerificationService;
  const makeService = (): PhoneVerificationService =>
    new PhoneVerificationService(redis, new LocalSmsSender(), {
      pepper: 'integration-pepper',
      exposeDevCode: true,
    });

  beforeAll(() => {
    redis = createRedis(redisUrl!);
  });
  beforeEach(() => {
    phone = `+861${randomInt(1_000_000_000, 10_000_000_000)}`;
    service = makeService();
  });
  afterEach(async () => {
    await redis.del(`auth:phone-code:LOGIN:${phone}`, `auth:phone-code-cooldown:LOGIN:${phone}`);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('不同服务实例并发核销仅一个成功', async () => {
    const sent = await service.send(phone, 'LOGIN');
    expect(sent.outcome).toBe('sent');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => makeService().verify(phone, 'LOGIN', sent.devCode!)),
    );
    expect(results.filter((result) => result === 'valid')).toHaveLength(1);
    expect(await redis.exists(`auth:phone-code:LOGIN:${phone}`)).toBe(0);
  });

  it('并发错误达到上限后不能再用正确码核销', async () => {
    const sent = await service.send(phone, 'LOGIN');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => makeService().verify(phone, 'LOGIN', 'invalid-code')),
    );
    expect(results.filter((result) => result === 'invalid')).toHaveLength(4);
    expect(results.filter((result) => result === 'too_many_attempts')).toHaveLength(1);
    expect(await service.verify(phone, 'LOGIN', sent.devCode!)).toBe('expired');
  });

  it('错误次数更新保留剩余有效期，不续期也不复活已删除的码', async () => {
    const sent = await service.send(phone, 'LOGIN');
    const key = `auth:phone-code:LOGIN:${phone}`;
    await redis.pexpire(key, 5000);
    expect(await service.verify(phone, 'LOGIN', 'invalid-code')).toBe('invalid');
    const remaining = await redis.pttl(key);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
    await Promise.all([
      service.verify(phone, 'LOGIN', sent.devCode!),
      makeService().verify(phone, 'LOGIN', 'invalid-code'),
    ]);
    expect(await redis.exists(key)).toBe(0);
  });
});

function createService(): PhoneVerificationService {
  return new PhoneVerificationService(new FakeRedis() as unknown as Redis, new LocalSmsSender(), {
    pepper: 'test-pepper',
    exposeDevCode: true,
  });
}

describe('手机验证码', () => {
  it('本地模式返回测试码，且正确码只能使用一次', async () => {
    const service = createService();
    const sent = await service.send('+8613900000000', 'REGISTER');
    expect(sent.outcome).toBe('sent');
    expect(sent.devCode).toMatch(/^\d{6}$/);

    expect(await service.verify('+8613900000000', 'REGISTER', sent.devCode ?? '')).toBe('valid');
    expect(await service.verify('+8613900000000', 'REGISTER', sent.devCode ?? '')).toBe('expired');
  });

  it('同一手机号与用途在冷却期内不能重复发送', async () => {
    const service = createService();
    expect((await service.send('+8613900000001', 'LOGIN')).outcome).toBe('sent');
    const repeated = await service.send('+8613900000001', 'LOGIN');
    expect(repeated).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: 60 });
  });

  it('并发正确请求只能核销一次', async () => {
    const service = createService();
    const sent = await service.send('+8613900000003', 'LOGIN');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.verify('+8613900000003', 'LOGIN', sent.devCode ?? ''),
      ),
    );
    expect(results.filter((result) => result === 'valid')).toHaveLength(1);
  });

  it('并发错误次数不会丢失，也不能复活已核销验证码', async () => {
    const service = createService();
    const phone = '+8613900000004';
    const sent = await service.send(phone, 'LOGIN');
    await Promise.all(
      Array.from({ length: 5 }, () => service.verify(phone, 'LOGIN', 'not-a-code')),
    );
    expect(await service.verify(phone, 'LOGIN', sent.devCode ?? '')).not.toBe('valid');
    const other = '+8613900000005';
    const next = await service.send(other, 'LOGIN');
    await Promise.all([
      service.verify(other, 'LOGIN', next.devCode ?? ''),
      service.verify(other, 'LOGIN', 'wrong'),
    ]);
    expect(await service.verify(other, 'LOGIN', next.devCode ?? '')).toBe('expired');
  });

  it('连续五次错误后验证码作废', async () => {
    const service = createService();
    const sent = await service.send('+8613900000002', 'LOGIN');
    const wrongCode = sent.devCode === '111111' ? '222222' : '111111';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.verify('+8613900000002', 'LOGIN', wrongCode)).toBe('invalid');
    }
    expect(await service.verify('+8613900000002', 'LOGIN', wrongCode)).toBe('too_many_attempts');
  });
});
