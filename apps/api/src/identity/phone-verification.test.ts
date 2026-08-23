import { describe, expect, it } from 'vitest';
import type { Redis } from '@tps/queue';

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

  ttl(key: string): Promise<number> {
    return Promise.resolve(this.ttls.get(key) ?? -2);
  }
}

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
