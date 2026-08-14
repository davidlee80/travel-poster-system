import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from './password.js';
import {
  COOKIE_NAMES,
  cookieAttributes,
  hashToken,
  issueOpaqueToken,
  tokensEqual,
} from './tokens.js';

describe('口令强度校验（13.9.2）', () => {
  it(`短于 ${MIN_PASSWORD_LENGTH} 字符被拒`, () => {
    const result = checkPasswordStrength('short1234');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TOO_SHORT');
  });

  it(`恰好 ${MIN_PASSWORD_LENGTH} 字符通过（边界）`, () => {
    expect(checkPasswordStrength('a1b2c3d4e5').ok).toBe(true);
  });

  it('弱口令字典命中被拒（大小写不敏感）', () => {
    for (const password of ['password123', 'PASSWORD123', 'Qwertyuiop']) {
      const result = checkPasswordStrength(password);
      expect(result.ok, `「${password}」应被拒`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('IN_WEAK_DICTIONARY');
    }
  });

  it('单字符重复被拒（满足长度但熵极低）', () => {
    const result = checkPasswordStrength('aaaaaaaaaaaa');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SINGLE_CHARACTER');
  });

  it('不强制字符类组合（NIST SP 800-63B：长度 + 黑名单优于组合规则）', () => {
    // 全小写、无数字、无符号，但长且不在字典里 → 通过
    expect(checkPasswordStrength('correcthorsebatterystaple').ok).toBe(true);
  });

  it('中文口令按字符数计长度', () => {
    expect(checkPasswordStrength('运河人文古今交融杭州行').ok).toBe(true);
    expect(checkPasswordStrength('运河人文').ok).toBe(false);
  });
});

describe('Argon2id 口令哈希', () => {
  it('哈希后可校验通过', async () => {
    const hash = await hashPassword('correcthorsebattery');
    expect(await verifyPassword(hash, 'correcthorsebattery')).toBe(true);
  });

  it('错误口令校验失败', async () => {
    const hash = await hashPassword('correcthorsebattery');
    expect(await verifyPassword(hash, 'wronghorsebattery')).toBe(false);
  });

  it('同一口令两次哈希结果不同（含随机盐）', async () => {
    const a = await hashPassword('correcthorsebattery');
    const b = await hashPassword('correcthorsebattery');

    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'correcthorsebattery')).toBe(true);
    expect(await verifyPassword(b, 'correcthorsebattery')).toBe(true);
  });

  it('哈希格式为 Argon2id', async () => {
    expect(await hashPassword('correcthorsebattery')).toMatch(/^\$argon2id\$/);
  });

  it('哈希损坏时返回 false 而不抛错（不让哈希损坏与口令错误产生可观测差异）', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('不截断长口令（bcrypt 的 72 字节问题）', async () => {
    const long = 'a'.repeat(100) + 'DIFFERENT';
    const alsoLong = 'a'.repeat(100) + 'OTHERSTUFF';

    const hash = await hashPassword(long);
    expect(await verifyPassword(hash, long)).toBe(true);
    expect(await verifyPassword(hash, alsoLong)).toBe(false);
  });
});

describe('不透明令牌（3.6.5）', () => {
  it('签发的令牌为 Base64URL，长度约 43 字符（32 字节）', () => {
    const { value } = issueOpaqueToken();

    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(value.length).toBeGreaterThanOrEqual(42);
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  });

  it('每次签发都不同', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => issueOpaqueToken().value));
    expect(tokens.size).toBe(100);
  });

  it('令牌不含 user_id 或任何可推导信息（不可枚举）', () => {
    const { value } = issueOpaqueToken();
    // 纯随机值不应包含结构性分隔符
    expect(value).not.toContain('.');
    expect(value).not.toContain(':');
  });

  it('哈希为 SHA-256 十六进制，且原文不可从哈希还原', () => {
    const { value, hash } = issueOpaqueToken();

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(value);
    expect(hashToken(value)).toBe(hash);
  });

  it('相同输入哈希一致，不同输入哈希不同', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('定时安全比较', () => {
  it('相等返回 true', () => {
    expect(tokensEqual('same-value', 'same-value')).toBe(true);
  });

  it('不等返回 false', () => {
    expect(tokensEqual('value-a', 'value-b')).toBe(false);
  });

  it('长度不同也返回 false 且不抛错', () => {
    expect(tokensEqual('short', 'much-longer-value')).toBe(false);
    expect(tokensEqual('', 'x')).toBe(false);
  });
});

describe('Cookie 属性（3.6.5）', () => {
  it('HttpOnly + SameSite=Lax + Path=/', () => {
    const attrs = cookieAttributes(2_592_000, true);

    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe('lax');
    expect(attrs.path).toBe('/');
    expect(attrs.maxAge).toBe(2_592_000);
  });

  it('secure 可关闭以支持 http://localhost 开发（否则浏览器根本不存）', () => {
    expect(cookieAttributes(60, false).secure).toBe(false);
    expect(cookieAttributes(60, true).secure).toBe(true);
  });

  it('Cookie 名称集中定义，避免各处拼写漂移', () => {
    expect(COOKIE_NAMES.anonymous).toBe('tp_anon');
    expect(COOKIE_NAMES.session).toBe('tp_session');
  });
});
