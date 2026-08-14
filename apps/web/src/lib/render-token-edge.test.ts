import { describe, expect, it } from 'vitest';
import { RENDER_PAGE_KEYS, issueRenderToken } from '@tps/shared';
import {
  MIN_SIGNING_KEY_LENGTH,
  isUsableSigningKey,
  parseRenderPath,
  verifyRenderTokenEdge,
} from './render-token-edge.js';

/**
 * **交叉验证**：用 `@tps/shared`（node:crypto）签发，用 Edge 实现（Web Crypto）校验。
 *
 * 这组测试守护的是最难排查的一类故障：签发与校验各自看起来都对，
 * 只有合在一起才错 —— 表现为「渲染 Worker 签的令牌，中间件不认」，
 * 而两侧日志都不会显示异常。
 */

const KEY = 'a'.repeat(48);
const NOW = 1_800_000_000_000;
const now = () => NOW;

const expected = { planVersionId: 'version_3', pageKey: RENDER_PAGE_KEYS.day(3) };

function sign(overrides: Partial<{ planVersionId: string; pageKey: string; jti: string }> = {}) {
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

describe('Edge 实现与 shared 实现的签名格式一致', () => {
  it('shared 签发的令牌可被 Edge 实现校验通过', async () => {
    const result = await verifyRenderTokenEdge(sign(), expected, KEY, now);
    expect(result.valid).toBe(true);
  });

  it('对全部 14 天与完整计划页都一致', async () => {
    for (let day = 1; day <= 14; day += 1) {
      const token = issueRenderToken(
        { planVersionId: 'v1', pageKey: RENDER_PAGE_KEYS.day(day), jti: `j${day}` },
        KEY,
        now,
      );
      const result = await verifyRenderTokenEdge(
        token,
        { planVersionId: 'v1', pageKey: RENDER_PAGE_KEYS.day(day) },
        KEY,
        now,
      );
      expect(result.valid, `day ${day}`).toBe(true);
    }

    const fullToken = issueRenderToken(
      { planVersionId: 'v1', pageKey: RENDER_PAGE_KEYS.full(), jti: 'jf' },
      KEY,
      now,
    );
    expect(
      (
        await verifyRenderTokenEdge(
          fullToken,
          { planVersionId: 'v1', pageKey: RENDER_PAGE_KEYS.full() },
          KEY,
          now,
        )
      ).valid,
    ).toBe(true);
  });

  it('含非 ASCII 的版本 ID 也一致（UTF-8 编码路径）', async () => {
    const token = issueRenderToken(
      { planVersionId: '版本-3', pageKey: 'full', jti: 'j' },
      KEY,
      now,
    );
    const result = await verifyRenderTokenEdge(
      token,
      { planVersionId: '版本-3', pageKey: 'full' },
      KEY,
      now,
    );
    expect(result.valid).toBe(true);
  });
});

describe('拒绝路径', () => {
  it('错误密钥被拒', async () => {
    const forged = issueRenderToken(
      { planVersionId: 'version_3', pageKey: 'day:3', jti: 'x' },
      'b'.repeat(48),
      now,
    );
    const result = await verifyRenderTokenEdge(forged, expected, KEY, now);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it('过期被拒', async () => {
    const token = sign();
    const later = () => NOW + 121_000;

    const result = await verifyRenderTokenEdge(token, expected, KEY, later);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('EXPIRED');
  });

  it('版本不匹配被拒（令牌不能挪用到其他计划）', async () => {
    const result = await verifyRenderTokenEdge(
      sign(),
      { planVersionId: 'version_4', pageKey: 'day:3' },
      KEY,
      now,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('VERSION_MISMATCH');
  });

  it('页面不匹配被拒（第 1 天的令牌不能取第 5 天）', async () => {
    const result = await verifyRenderTokenEdge(
      sign({ pageKey: RENDER_PAGE_KEYS.day(1) }),
      { planVersionId: 'version_3', pageKey: RENDER_PAGE_KEYS.day(5) },
      KEY,
      now,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('PAGE_MISMATCH');
  });

  it('篡改签名被拒', async () => {
    const token = sign();
    const dot = token.indexOf('.');
    const broken = `${token.slice(0, dot)}.${'Z'.repeat(token.length - dot - 1)}`;

    const result = await verifyRenderTokenEdge(broken, expected, KEY, now);
    expect(result.valid).toBe(false);
  });

  it.each(['', '.', 'nodot', 'a.', '.b', '!!!.???'])(
    '畸形令牌 "%s" 被拒且不抛错',
    async (token) => {
      const result = await verifyRenderTokenEdge(token, expected, KEY, now);
      expect(result.valid).toBe(false);
    },
  );
});

describe('路径解析（17.1 的两条路由）', () => {
  it('解析单日路由', () => {
    expect(parseRenderPath('/render/plans/version_3/days/3')).toEqual({
      planVersionId: 'version_3',
      pageKey: 'day:3',
    });
  });

  it('解析完整计划页路由', () => {
    expect(parseRenderPath('/render/plans/version_3/full')).toEqual({
      planVersionId: 'version_3',
      pageKey: 'full',
    });
  });

  it('容忍尾部斜杠', () => {
    expect(parseRenderPath('/render/plans/v1/days/1/')).not.toBeNull();
    expect(parseRenderPath('/render/plans/v1/full/')).not.toBeNull();
  });

  it('URL 编码的版本 ID 被解码', () => {
    expect(parseRenderPath('/render/plans/%E7%89%88%E6%9C%AC-3/full')?.planVersionId).toBe(
      '版本-3',
    );
  });

  it.each([
    '/render/plans/v1',
    '/render/plans/v1/days',
    '/render/plans/v1/days/abc',
    '/render/plans/v1/days/1/extra',
    '/render',
    '/api/v1/auth/session',
    '/render/plans//days/1',
  ])('无法解析的路径 "%s" 返回 null（中间件据此拒绝）', (pathname) => {
    expect(parseRenderPath(pathname)).toBeNull();
  });
});

describe('签名密钥强度（fail closed）', () => {
  it('未配置时不可用', () => {
    expect(isUsableSigningKey(undefined)).toBe(false);
  });

  it('过短时不可用（等于没有保护）', () => {
    expect(isUsableSigningKey('short')).toBe(false);
    expect(isUsableSigningKey('a'.repeat(MIN_SIGNING_KEY_LENGTH - 1))).toBe(false);
  });

  it('达到最小长度时可用', () => {
    expect(isUsableSigningKey('a'.repeat(MIN_SIGNING_KEY_LENGTH))).toBe(true);
  });
});
