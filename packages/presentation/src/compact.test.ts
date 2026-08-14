import { describe, expect, it } from 'vitest';
import { COMPACT_LIMITS, compactL1, compactL2, toCompact } from './compact.js';

/**
 * 压缩规则测试（设计稿 3.2.3）。
 *
 * 核心不变式：**压缩后长度必须 ≤ 限长**。这一条如果不成立，17.3 的溢出
 * 重渲染第 2 轮就是无效的 —— 切到压缩文案后仍然溢出，白跑一轮渲染。
 */

describe('不变式：压缩后长度不超过限长', () => {
  const samples = [
    '运河人文·古今交融',
    '在水巷与博物馆之间，慢慢读懂杭州的另一面',
    '参观运河沿岸历史建筑与专题展览，非常适合喜欢历史文化的旅行者细细品味其中的细节。',
    '这一天更适合慢节奏，白天看展，傍晚逛运河，晚上可以在大兜路找一家沿河茶楼坐下来，看灯光倒影在水面上慢慢铺开。',
    '前往参观位于运河北端的中国大运河博物馆（免费但需预约），深入了解运河的开凿史与沿岸生活。',
    '短',
    '',
  ];

  const limits = [10, 18, 20, 24, 32, 40];

  it.each(limits)('限长 %i 下所有样本都不超限', (limit) => {
    for (const sample of samples) {
      const result = toCompact(sample, limit);
      expect(result.length, `样本「${sample}」压缩后为「${result}」`).toBeLessThanOrEqual(limit);
    }
  });

  it.each(limits)('限长 %i 下 L1 与 L2 单独调用也不超限', (limit) => {
    for (const sample of samples) {
      expect(compactL1(sample, limit).length).toBeLessThanOrEqual(limit);
      expect(compactL2(sample, limit).length).toBeLessThanOrEqual(limit);
    }
  });
});

describe('原文已达标时不做任何改动', () => {
  it.each([
    ['短标题', 18],
    ['运河人文·古今交融', 18],
    ['', 18],
  ])('「%s」在限长 %i 内原样返回', (text, limit) => {
    expect(toCompact(text, limit)).toBe(text);
  });

  it('恰好等于限长时也原样返回（边界）', () => {
    const text = '一二三四五六七八九十';
    expect(text.length).toBe(10);
    expect(toCompact(text, 10)).toBe(text);
  });

  it('超限 1 个字符时才开始压缩', () => {
    const text = '一二三四五六七八九十一';
    expect(text.length).toBe(11);
    expect(toCompact(text, 10)).not.toBe(text);
  });
});

describe('L1：去修饰与括号，按标点截断', () => {
  it('删除修饰性副词', () => {
    const result = compactL1('这里非常适合慢节奏的旅行', 40);
    expect(result).not.toContain('非常');
    expect(result).toContain('适合慢节奏');
  });

  it('删除括号及其内容（全角与半角）', () => {
    expect(compactL1('中国大运河博物馆（免费但需预约）', 40)).toBe('中国大运河博物馆');
    expect(compactL1('大兜路(沿河)茶楼', 40)).toBe('大兜路茶楼');
    expect(compactL1('拱宸桥【推荐】', 40)).toBe('拱宸桥');
  });

  it('优先在标点边界收尾，不留孤立的逗号', () => {
    const result = compactL1('白天看展，傍晚逛运河，夜里回酒店休息', 12);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result).not.toMatch(/[，、：；]$/);
  });

  it('找不到标点边界时硬截断并加省略号', () => {
    const result = compactL1('拱宸桥大运河博物馆丝绸博物馆大兜路武林门码头', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('清理删词后产生的连续标点', () => {
    expect(compactL1('看展，，逛运河', 40)).toBe('看展，逛运河');
  });
});

describe('L2：规则化缩写', () => {
  it('设计稿示例：「参观运河沿岸历史建筑与专题展览。」压到 24 字内', () => {
    const result = compactL2(
      '参观运河沿岸历史建筑与专题展览。',
      COMPACT_LIMITS.scheduleDescription,
    );

    expect(result.length).toBeLessThanOrEqual(COMPACT_LIMITS.scheduleDescription);
    expect(result).toContain('运河');
  });

  it('应用短语缩写表', () => {
    expect(compactL2('参观游览拱宸桥', 40)).toBe('参观拱宸桥');
    expect(compactL2('深入了解运河文化', 40)).toBe('了解运河文化');
    expect(compactL2('历史文化街区漫步', 40)).toBe('历史街区漫步');
  });

  it('仍超限时只保留第一个完整分句', () => {
    const text = '白天在博物馆看专题展。傍晚沿运河散步。夜里在茶楼喝茶。';
    const result = compactL2(text, 14);

    expect(result.length).toBeLessThanOrEqual(14);
    expect(result).not.toContain('夜里');
  });
});

describe('toCompact 的分级行为', () => {
  it('L1 足够时不动用 L2', () => {
    // 必须超限才会进入压缩分支；否则 toCompact 会短路返回原文
    const text = '这里非常适合慢节奏（很悠闲）的旅行者慢慢体会';
    expect(text.length).toBeGreaterThan(18);

    const l1 = compactL1(text, 18);
    expect(l1.length).toBeLessThanOrEqual(18);
    expect(toCompact(text, 18)).toBe(l1);
  });

  it('L1 不够时升级到 L2', () => {
    const text = '前往参观游览位于运河北端的中国大运河博物馆，深入了解运河的开凿史与沿岸生活。';
    const result = toCompact(text, 16);

    expect(result.length).toBeLessThanOrEqual(16);
  });

  it('空串与单字符不崩溃', () => {
    expect(toCompact('', 10)).toBe('');
    expect(toCompact('好', 10)).toBe('好');
    expect(toCompact('好', 1)).toBe('好');
  });

  it('限长为 1 时仍返回非空结果（不能把内容压成空白）', () => {
    const result = toCompact('运河人文古今交融', 1);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe('限长常量与设计稿一致', () => {
  it('标题 18 字、副标题 32 字（业务规则 V-40）', () => {
    expect(COMPACT_LIMITS.title).toBe(18);
    expect(COMPACT_LIMITS.subtitle).toBe(32);
  });

  it('每日总结 40 字（6.2 对 daily_summary 的规定）', () => {
    expect(COMPACT_LIMITS.dailySummary).toBe(40);
  });
});
