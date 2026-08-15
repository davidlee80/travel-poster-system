import { describe, expect, it } from 'vitest';
import {
  FONT_FAMILIES,
  FONT_STACK_NUMERIC,
  FONT_STACK_SANS,
  FONT_STACK_SERIF,
  FONT_WEIGHTS,
  fontAssets,
  fontFaceCss,
} from './families.js';

describe('字体清单', () => {
  it('17.5 要求的三个字体族齐全', () => {
    expect(FONT_FAMILIES.map((f) => f.cssFamily)).toEqual([
      'Noto Sans SC',
      'Noto Serif SC',
      'Inter',
    ]);
  });

  it('每个族三档字重，共 9 个资产', () => {
    expect(fontAssets()).toHaveLength(FONT_FAMILIES.length * FONT_WEIGHTS.length);
  });

  it('资产文件名互不重复', () => {
    const files = fontAssets().map((a) => a.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('体积上下限自身自洽', () => {
    for (const family of FONT_FAMILIES) {
      expect(family.minBytes, `${family.id} 的下限应小于上限`).toBeLessThan(family.maxBytes);
    }
  });

  it('CJK 字体要求完整覆盖，拉丁字体不要求', () => {
    // 把 Noto 的 coverage 降为 ascii 会让构建期的缺字校验形同虚设 ——
    // 这条断言让那种放松无法悄悄发生
    const byId = new Map(FONT_FAMILIES.map((f) => [f.id, f.coverage]));
    expect(byId.get('noto-sans-sc')).toBe('full');
    expect(byId.get('noto-serif-sc')).toBe('full');
    expect(byId.get('inter')).toBe('ascii');
  });
});

describe('字体栈', () => {
  it('子集字体排在完整系统字体之前', () => {
    /*
     * 顺序颠倒的后果不是「不好看」，而是全部文字都走系统字体：
     * 视觉基线（TP-1-16）立刻与 CI 不一致，且 @font-face 子集完全没被用到 ——
     * 而页面看起来是正常的，没有任何报错。
     */
    expect(FONT_STACK_SANS.indexOf("'Noto Sans SC'")).toBeLessThan(
      FONT_STACK_SANS.indexOf("'Noto Sans CJK SC'"),
    );
    expect(FONT_STACK_SERIF.indexOf("'Noto Serif SC'")).toBeLessThan(
      FONT_STACK_SERIF.indexOf("'Noto Serif CJK SC'"),
    );
  });

  it('每个栈都有 CJK 兜底', () => {
    // 数字栈以 Inter 开头，但金额旁边常有「元」「起」这类汉字，
    // 没有 CJK 兜底就会掉到 sans-serif 的默认字体上，字形与正文不一致
    for (const stack of [FONT_STACK_SANS, FONT_STACK_SERIF, FONT_STACK_NUMERIC]) {
      expect(stack, `${stack} 缺少 CJK 兜底`).toMatch(/Noto (Sans|Serif)/);
    }
  });
});

describe('fontFaceCss', () => {
  const css = fontFaceCss('/fonts/');

  it('为每个资产生成一条规则', () => {
    expect(css.match(/@font-face/g)).toHaveLength(9);
  });

  it('全部使用 font-display: block', () => {
    /*
     * 17.5 明确要求「导出场景宁可等待也不能截到回退字体」。
     * swap 会先用回退字体绘制一帧，而 Playwright 完全可能截在那一帧上 ——
     * 产出的 PNG 字体不对，但任务成功、没有任何错误。
     */
    expect(css.match(/font-display: block/g)).toHaveLength(9);
    expect(css).not.toContain('swap');
  });

  it('URL 使用传入前缀且始终是正斜杠', () => {
    expect(css).toContain("url('/fonts/noto-sans-sc-400.woff2')");
    /*
     * 22.3.3：路径分隔符一律用 /，反斜杠在 Linux 上不是分隔符。
     * 用字符码构造而不是写字面量 —— 字面量会被 tps-local/no-windows-path-separator
     * 判为「硬编码 Windows 分隔符」，而这里正是在断言它不存在。
     */
    const backslash = String.fromCharCode(0x5c);
    expect(css).not.toContain(backslash);
  });

  it('三档字重都出现', () => {
    for (const weight of FONT_WEIGHTS) {
      expect(css).toContain(`font-weight: ${weight};`);
    }
  });

  it('空前缀合法（同目录引用）', () => {
    expect(fontFaceCss('')).toContain("url('noto-sans-sc-400.woff2')");
  });

  it('前缀缺少结尾斜杠时抛错而不是静默拼错', () => {
    // 静默拼成 /fontsnoto-sans-sc-400.woff2 的后果是 404 → 回退字体 →
    // 中文变成系统字体，页面仍然「正常」渲染，缺陷只在像素比对时才暴露
    expect(() => fontFaceCss('/fonts')).toThrow(/必须以/);
  });
});
