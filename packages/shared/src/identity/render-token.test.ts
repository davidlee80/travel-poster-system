import { describe, expect, it } from 'vitest';
import {
  RENDER_PAGE_KEYS,
  RENDER_TOKEN_TTL_SECONDS,
  issueRenderToken,
  verifyRenderToken,
} from './render-token.js';

const KEY = 'test-signing-key-do-not-use-in-production';
const NOW = 1_800_000_000_000;
const now = () => NOW;

function issue(overrides: Partial<Parameters<typeof issueRenderToken>[0]> = {}): string {
  return issueRenderToken(
    {
      planVersionId: 'version_3',
      pageKey: RENDER_PAGE_KEYS.day(3),
      jti: 'jti-1',
      ...overrides,
    },
    KEY,
    now,
  );
}

const expected = { planVersionId: 'version_3', pageKey: RENDER_PAGE_KEYS.day(3) };

describe('渲染令牌签发与校验（17.1）', () => {
  it('自签自验通过', () => {
    const result = verifyRenderToken(issue(), expected, KEY, now);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.planVersionId).toBe('version_3');
      expect(result.payload.pageKey).toBe('day:3');
      expect(result.payload.jti).toBe('jti-1');
    }
  });

  it('默认有效期为 120 秒', () => {
    const result = verifyRenderToken(issue(), expected, KEY, now);
    if (!result.valid) throw new Error('should be valid');

    expect(result.payload.expiresAtMs).toBe(NOW + RENDER_TOKEN_TTL_SECONDS * 1000);
  });

  it('过期令牌被拒', () => {
    const token = issue();
    const later = () => NOW + (RENDER_TOKEN_TTL_SECONDS + 1) * 1000;

    const result = verifyRenderToken(token, expected, KEY, later);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('EXPIRED');
  });

  it('恰好到期的瞬间即失效（边界）', () => {
    const token = issue();
    const atExpiry = () => NOW + RENDER_TOKEN_TTL_SECONDS * 1000;

    const result = verifyRenderToken(token, expected, KEY, atExpiry);
    expect(result.valid).toBe(false);
  });
});

describe('伪造与篡改', () => {
  it('错误密钥签发的令牌被拒', () => {
    const forged = issueRenderToken(
      { planVersionId: 'version_3', pageKey: 'day:3', jti: 'x' },
      'wrong-key',
      now,
    );

    const result = verifyRenderToken(forged, expected, KEY, now);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it('篡改 payload 后签名不匹配', () => {
    const token = issue();
    const [payload, signature] = token.split('.');

    const tampered = Buffer.from('version_9|day:3|9999999999999|jti-1', 'utf8').toString(
      'base64url',
    );
    const result = verifyRenderToken(`${tampered}.${signature as string}`, expected, KEY, now);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('BAD_SIGNATURE');
    expect(payload).not.toBe(tampered);
  });

  it('篡改签名被拒', () => {
    const token = issue();
    const dot = token.indexOf('.');
    const broken = `${token.slice(0, dot)}.${'A'.repeat(token.length - dot - 1)}`;

    const result = verifyRenderToken(broken, expected, KEY, now);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it.each(['', '.', 'nodot', 'a.', '.b'])('畸形令牌 "%s" 被拒且不抛错', (token) => {
    const result = verifyRenderToken(token, expected, KEY, now);
    expect(result.valid).toBe(false);
  });
});

describe('绑定校验：签名有效 ≠ 允许用于当前页面', () => {
  it('令牌被挪用到其他计划版本时被拒', () => {
    const token = issue({ planVersionId: 'version_3' });

    const result = verifyRenderToken(
      token,
      { planVersionId: 'version_4', pageKey: 'day:3' },
      KEY,
      now,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('VERSION_MISMATCH');
  });

  it('令牌被挪用到其他天时被拒', () => {
    const token = issue({ pageKey: RENDER_PAGE_KEYS.day(3) });

    const result = verifyRenderToken(
      token,
      { planVersionId: 'version_3', pageKey: RENDER_PAGE_KEYS.day(5) },
      KEY,
      now,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('PAGE_MISMATCH');
  });

  it('单日令牌不能用于完整计划页', () => {
    const token = issue({ pageKey: RENDER_PAGE_KEYS.day(1) });

    const result = verifyRenderToken(
      token,
      { planVersionId: 'version_3', pageKey: RENDER_PAGE_KEYS.full() },
      KEY,
      now,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('PAGE_MISMATCH');
  });
});

describe('分隔符注入', () => {
  it('字段含分隔符时拒绝签发（否则可构造出不同语义的等价 payload）', () => {
    expect(() =>
      issueRenderToken({ planVersionId: 'version_3|day:9', pageKey: 'day:3', jti: 'x' }, KEY, now),
    ).toThrow(/不得包含/);

    expect(() =>
      issueRenderToken({ planVersionId: 'v', pageKey: 'day:3|x', jti: 'y' }, KEY, now),
    ).toThrow(/不得包含/);
  });
});

describe('页面标识', () => {
  it('与 17.1 的路由一一对应', () => {
    expect(RENDER_PAGE_KEYS.day(3)).toBe('day:3');
    expect(RENDER_PAGE_KEYS.full()).toBe('full');
  });

  it('不同天的标识互不相同', () => {
    const keys = new Set(Array.from({ length: 14 }, (_, i) => RENDER_PAGE_KEYS.day(i + 1)));
    expect(keys.size).toBe(14);
    expect(keys.has(RENDER_PAGE_KEYS.full())).toBe(false);
  });
});
