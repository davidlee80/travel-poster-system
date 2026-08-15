import { describe, expect, it } from 'vitest';

import { RENDER_ERROR_CODES, RenderError, isBlocking } from './errors.js';

describe('阻断判定（16.3）', () => {
  it('溢出未解决不阻断', () => {
    /*
     * 这条最容易被写反。17.3 的终止分支明确要求「输出当前产物」——
     * 判成阻断会让「文案偏长」这种小问题变成任务失败，
     * 而用户本可以拿到一份轻微降级但完全可用的信息图。
     */
    expect(isBlocking(RENDER_ERROR_CODES.overflowUnresolved)).toBe(false);
  });

  it('模板失败与超时阻断', () => {
    expect(isBlocking(RENDER_ERROR_CODES.templateFailed)).toBe(true);
    expect(isBlocking(RENDER_ERROR_CODES.timeout)).toBe(true);
  });

  it('每个码都有明确的阻断判定', () => {
    // 新增码时若忘了考虑阻断语义，这条会提醒：所有码都必须被 isBlocking 覆盖
    for (const code of Object.values(RENDER_ERROR_CODES)) {
      expect(typeof isBlocking(code)).toBe('boolean');
    }
  });
});

describe('RenderError', () => {
  it('携带码与细分原因', () => {
    const error = new RenderError(
      RENDER_ERROR_CODES.templateFailed,
      '中文字形不可用',
      'CJK_FONT_UNAVAILABLE',
    );

    expect(error.code).toBe('RENDER_TEMPLATE_FAILED');
    expect(error.detail).toBe('CJK_FONT_UNAVAILABLE');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RenderError');
  });

  it('detail 可省略', () => {
    expect(new RenderError(RENDER_ERROR_CODES.timeout, '超时').detail).toBeUndefined();
  });
});
