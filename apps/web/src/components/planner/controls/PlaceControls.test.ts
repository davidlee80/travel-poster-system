import { describe, expect, it } from 'vitest';

import {
  addDays,
  cascadeAfterRemoval,
  cascadeDestinations,
  daysBetween,
  formatDate,
  parseDate,
  type DestinationValue,
} from './PlaceControls';

describe('parseDate', () => {
  it('解析合法日期', () => {
    const date = parseDate('2026-01-15');
    expect(date).toBeDefined();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(0); // 一月是 0
    expect(date?.getDate()).toBe(15);
  });

  it('空字符串返回 undefined', () => {
    expect(parseDate('')).toBeUndefined();
    expect(parseDate('   ')).toBeUndefined();
  });

  it('undefined 返回 undefined', () => {
    expect(parseDate(undefined)).toBeUndefined();
  });

  it('非法格式返回 undefined', () => {
    expect(parseDate('2026/01/15')).toBeUndefined();
    expect(parseDate('abc')).toBeUndefined();
    expect(parseDate('2026-13-45')).toBeDefined(); // Date 会溢出，不视为非法格式
  });
});

describe('formatDate', () => {
  it('格式化为 YYYY-MM-DD', () => {
    const date = new Date(2026, 0, 5); // 2026-01-05
    expect(formatDate(date)).toBe('2026-01-05');
  });

  it('补零', () => {
    const date = new Date(2026, 11, 25); // 2026-12-25
    expect(formatDate(date)).toBe('2026-12-25');
  });
});

describe('daysBetween', () => {
  it('计算天数差', () => {
    const d1 = new Date(2026, 0, 1);
    const d2 = new Date(2026, 0, 5);
    expect(daysBetween(d1, d2)).toBe(4);
  });

  it('负天数差', () => {
    const d1 = new Date(2026, 0, 5);
    const d2 = new Date(2026, 0, 1);
    expect(daysBetween(d1, d2)).toBe(-4);
  });
});

describe('addDays', () => {
  it('日期加天数', () => {
    expect(addDays('2026-01-01', 3)).toBe('2026-01-04');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('空输入返回 undefined', () => {
    expect(addDays('', 3)).toBeUndefined();
  });
});

describe('cascadeDestinations', () => {
  it('修改驻留天数后级联更新后续所有日期', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 5 }, // 改为 5 天
      { text: '大阪' },
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[0]?.stay_days).toBe(5);
    expect(result[1]?.arrival_date).toBe('2026-03-06');
    // 第三行没有日期，不级联（因为第二行没有 stay_days）
    expect(result[2]?.arrival_date).toBeUndefined();
  });

  it('下一行已有日期且一致时不改动', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 3 },
      { text: '大阪', arrival_date: '2026-03-04' }, // 恰好是 3 天后
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[0]?.stay_days).toBe(3); // 不变
    expect(result[1]?.arrival_date).toBe('2026-03-04'); // 不变
  });

  it('下一行日期冲突时回推当前行驻留天数', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 3 },
      { text: '大阪', arrival_date: '2026-03-10' }, // 用户手动改成了 10 号
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[0]?.stay_days).toBe(9); // 3月10日 - 3月1日 = 9 天
    expect(result[1]?.arrival_date).toBe('2026-03-10'); // 保持用户输入
  });

  it('下一行日期早于当前行时保持推算值', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-10', stay_days: 3 },
      { text: '大阪', arrival_date: '2026-03-01' }, // 用户输入了一个更早的日期
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[0]?.stay_days).toBe(3); // 无法回推，保持不变
    expect(result[1]?.arrival_date).toBe('2026-03-13'); // 被推算值覆盖
  });

  it('当前行缺少日期时停止级联', () => {
    const list: DestinationValue[] = [
      { text: '东京' }, // 没有日期
      { text: '大阪', arrival_date: '2026-03-04', stay_days: 2 },
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[1]?.arrival_date).toBe('2026-03-04'); // 不变
    // 第二行（大阪）有完整信息，会继续级联到第三行
    expect(result[2]?.arrival_date).toBe('2026-03-06');
  });

  it('当前行缺少驻留天数时停止级联', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01' }, // 没有驻留天数
      { text: '大阪' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[1]?.arrival_date).toBeUndefined();
  });

  it('从中间行开始级联', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 3 },
      { text: '大阪', arrival_date: '2026-03-04', stay_days: 5 }, // 修改这里
      { text: '京都' },
    ];
    const result = cascadeDestinations(list, 1);
    expect(result[0]?.arrival_date).toBe('2026-03-01'); // 第一行不受影响
    expect(result[1]?.stay_days).toBe(5);
    expect(result[2]?.arrival_date).toBe('2026-03-09'); // 3月4日 + 5天
  });

  it('级联多行', () => {
    const list: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 2 },
      { text: '大阪', stay_days: 3 },
      { text: '京都', stay_days: 1 },
      { text: '奈良' },
    ];
    const result = cascadeDestinations(list, 0);
    expect(result[1]?.arrival_date).toBe('2026-03-03');
    expect(result[2]?.arrival_date).toBe('2026-03-06');
    expect(result[3]?.arrival_date).toBe('2026-03-07');
  });

  it('空列表安全返回', () => {
    expect(cascadeDestinations([], 0)).toEqual([]);
    expect(cascadeDestinations([{ text: '东京' }], 0)).toEqual([{ text: '东京' }]);
  });
});

describe('cascadeAfterRemoval', () => {
  it('删除中间行后重新计算后续日期', () => {
    // 模拟删除后的列表（京都已被移除）
    // 奈良的日期是用户手动输入的（2026-03-10），与推算值不一致时以用户输入为主
    const listAfterRemoval: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 3 },
      { text: '大阪', arrival_date: '2026-03-04', stay_days: 2 },
      { text: '奈良', arrival_date: '2026-03-10' }, // 用户手动输入的日期
    ];
    // 从索引 1（大阪）开始级联：大阪 3月4日 + 2天 = 3月6日
    // 但奈良已有日期 3月10日，冲突检测会回推大阪的驻留天数为 6 天
    const result = cascadeAfterRemoval(listAfterRemoval, 2);
    expect(result).toHaveLength(3);
    expect(result[1]?.stay_days).toBe(6); // 回推：3月10日 - 3月4日 = 6 天
    expect(result[2]?.arrival_date).toBe('2026-03-10'); // 保持用户输入
  });

  it('删除第一行后从第一行开始级联', () => {
    // 模拟删除后的列表（东京已被移除）
    const listAfterRemoval: DestinationValue[] = [
      { text: '大阪', arrival_date: '2026-03-04', stay_days: 2 },
      { text: '京都' },
    ];
    const result = cascadeAfterRemoval(listAfterRemoval, 0);
    expect(result).toHaveLength(2);
    expect(result[0]?.arrival_date).toBe('2026-03-04');
    expect(result[1]?.arrival_date).toBe('2026-03-06');
  });

  it('删除最后一行不影响前面', () => {
    // 模拟删除后的列表（大阪已被移除）
    const listAfterRemoval: DestinationValue[] = [
      { text: '东京', arrival_date: '2026-03-01', stay_days: 3 },
    ];
    const result = cascadeAfterRemoval(listAfterRemoval, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.arrival_date).toBe('2026-03-01');
  });
});
