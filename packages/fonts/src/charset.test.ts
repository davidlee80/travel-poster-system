import { describe, expect, it } from 'vitest';
import {
  EXTRA_CHARACTERS,
  GB2312_HANZI_COUNT,
  charsetFingerprint,
  findUncoveredCharacters,
  gb2312Hanzi,
  gb2312Symbols,
  subsetCodepoints,
} from './charset.js';

describe('GB 2312 枚举', () => {
  it('汉字数正好是标准规定的 6763', () => {
    // 这不是回归基线而是外部标准。数量偏移意味着区位码枚举写错了，
    // 而少了的那些字在页面上就是豆腐块 —— 没有别的表现形式。
    expect(gb2312Hanzi()).toHaveLength(GB2312_HANZI_COUNT);
  });

  it('汉字区首末字符符合 GB 2312 定义', () => {
    const hanzi = gb2312Hanzi();
    // 第 16 区第 1 位 = 「啊」，一级字表的第一个字
    expect(hanzi[0]).toBe('啊');
    // 第 87 区第 94 位 = 「齄」，二级字表的最后一个字
    expect(hanzi.at(-1)).toBe('齄');
  });

  it('符号区含常用标点与全角字符', () => {
    const symbols = new Set(gb2312Symbols());
    for (const ch of ['、', '。', '「', '」', '·', '％', 'Ａ', '１', '℃', '×']) {
      expect(symbols, `符号区应含 ${ch}`).toContain(ch);
    }
  });

  it('不含私用区码点', () => {
    // GBK 把 GB 2312 的未分配单元格填到私用区，那些码位在不同字体里
    // 字形完全不同，进入子集只会产生不可预期的渲染结果
    for (const code of subsetCodepoints()) {
      expect(code < 0xe000 || code > 0xf8ff, `U+${code.toString(16)} 落在私用区`).toBe(true);
    }
  });
});

describe('EXTRA_CHARACTERS', () => {
  it('每一个都确实不在 GB 2312 与 ASCII 之内', () => {
    /*
     * 已在 GB 2312 里的字符出现在这里说明作者对字符集有误解 ——
     * 它不会造成故障，但会让后来人以为「必须显式列出才会被包含」，
     * 于是往里堆越来越多无用条目，最终这份清单失去筛选意义。
     */
    const base = new Set([...gb2312Hanzi(), ...gb2312Symbols()].map((c) => c.codePointAt(0)));

    for (const ch of EXTRA_CHARACTERS) {
      const code = ch.codePointAt(0)!;
      const isAscii = code >= 0x20 && code <= 0x7e;
      expect(base.has(code) || isAscii, `${ch} 已被 GB 2312 或 ASCII 覆盖，不必列出`).toBe(false);
    }
  });

  it('无重复', () => {
    expect(new Set(EXTRA_CHARACTERS).size).toBe(EXTRA_CHARACTERS.length);
  });
});

describe('findUncoveredCharacters', () => {
  it('常规中文文案全部覆盖', () => {
    const text = '第 3 天 · 拱宸桥与运河博物馆，人均 ¥180，步行 25 分钟。';
    expect(findUncoveredCharacters(text)).toEqual([]);
  });

  it('报出 GB 2312 之外的生僻字', () => {
    // 「氹」（氹仔／澳门地名）与「𠮷」都不在 GB 2312 内，是真实会出现在地名里的字
    expect(findUncoveredCharacters('氹仔')).toEqual(['氹']);
  });

  it('结果去重且保持首次出现顺序', () => {
    expect(findUncoveredCharacters('氹埗氹')).toEqual(['氹', '埗']);
  });

  it('忽略控制字符与换行', () => {
    // 换行与制表不需要字形，把它们报成「未覆盖」会让每段多行文案都触发告警
    expect(findUncoveredCharacters('杭州\n西湖\t断桥')).toEqual([]);
  });

  it('正确处理代理对，不把一个字拆成两个', () => {
    // 用 for...of 遍历字符串而不是按 UTF-16 码元，否则辅助平面字符会被
    // 报成两个「未覆盖字符」，且两半都不是真实字符
    const result = findUncoveredCharacters('𠮷');
    expect(result).toEqual(['𠮷']);
    expect(result[0]!.length).toBe(2);
  });
});

describe('charsetFingerprint', () => {
  it('同一字符集得到同一指纹', () => {
    expect(charsetFingerprint()).toBe(charsetFingerprint());
  });

  it('指纹以码点数量开头，便于人工核对', () => {
    expect(charsetFingerprint()).toMatch(new RegExp(`^${subsetCodepoints().size}-[0-9a-f]{8}$`));
  });
});
