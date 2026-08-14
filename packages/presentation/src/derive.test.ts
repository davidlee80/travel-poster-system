import { describe, expect, it } from 'vitest';
import {
  BOOKING_CATEGORY_VALUES,
  MEAL_VALUES,
  PERIOD_VALUES,
  PREFERRED_TIME_VALUES,
  ROUTE_TYPE_VALUES,
  TRANSPORT_MODE_VALUES,
} from '@tps/schemas';
import {
  BOOKING_CATEGORY_LABEL,
  MEAL_LABEL,
  PERIOD_LABEL,
  PREFERRED_TIME_LABEL,
  ROUTE_TYPE_LABEL,
  advanceText,
  amountText,
  dayLabel,
  durationText,
  periodIconName,
  priceText,
  sourceNote,
  totalText,
  transportIconName,
} from './derive.js';

/**
 * 表驱动测试，逐条对照设计稿 12.1 的规则表。
 *
 * 这些函数的输出直接出现在用户看到的页面上，且没有类型能约束「文案是否
 * 符合规则」，因此规则表的每一行都必须有对应断言 —— 否则 12.1 就只是一份
 * 没人执行的文档。
 */

describe('12.1 时长文案（duration_text）', () => {
  it.each([
    // [输入分钟, 期望输出, 说明]
    [150, '建议 2～3 小时', '设计稿示例值'],
    [120, '建议 2 小时', '整小时'],
    [60, '建议 1 小时', '恰好 1 小时'],
    [180, '建议 3 小时', '整小时'],
    [45, '约 45 分钟', '不足 1 小时'],
    [59, '约 59 分钟', '不足 1 小时的上边界'],
    [1, '约 1 分钟', '最小正值'],
    [61, '建议 1～2 小时', '刚过整小时'],
    [90, '建议 1～2 小时', '半小时余数'],
    [840, '建议 14 小时', '大值整小时'],
  ])('%i 分钟 → "%s"（%s）', (minutes, expected) => {
    expect(durationText(minutes)).toBe(expected);
  });

  it.each([0, -1, -60, Number.NaN, Number.POSITIVE_INFINITY])(
    '非正数或非有限值 %s 返回空串，由调用方决定是否隐藏',
    (value) => {
      expect(durationText(value)).toBe('');
    },
  );

  it('小数分钟先四舍五入', () => {
    expect(durationText(59.4)).toBe('约 59 分钟');
    expect(durationText(59.6)).toBe('建议 1 小时');
  });
});

describe('12.1 金额文案（amount_text）', () => {
  it.each([
    [0, '¥0', '零值不加「约」'],
    [10, '约 ¥10', '10 的整数倍是估算值特征'],
    [25, '¥25', '非 10 整数倍是精确值'],
    [70, '约 ¥70', '10 的整数倍'],
    [105, '¥105', '非 10 整数倍'],
    [100, '约 ¥100', '10 的整数倍'],
    [5, '¥5', '小额精确值'],
  ])('%i → "%s"（%s）', (amount, expected) => {
    expect(amountText({ amount, currency: 'CNY' })).toBe(expected);
  });

  it('四舍五入到整数展示，底层小数不泄漏到页面', () => {
    expect(amountText({ amount: 10.4, currency: 'CNY' })).toBe('约 ¥10');
    expect(amountText({ amount: 10.6, currency: 'CNY' })).toBe('¥11');
    expect(amountText({ amount: 0.4, currency: 'CNY' })).toBe('¥0');
  });

  it('负数不崩溃（V-24 会在业务规则层修复为 0，展示层只需不出错）', () => {
    expect(amountText({ amount: -5, currency: 'CNY' })).toBe('¥-5');
  });
});

describe('12.1 总额文案（total_text）', () => {
  it('设计稿示例：105 → "约 ¥105 / 人"', () => {
    expect(totalText(105, 'CNY')).toBe('约 ¥105 / 人');
  });

  it.each([
    [0, '约 ¥0 / 人'],
    [953.33, '约 ¥953 / 人'],
    [953.67, '约 ¥954 / 人'],
  ])('%s → "%s"', (total, expected) => {
    expect(totalText(total, 'CNY')).toBe(expected);
  });
});

describe('12.1 门票价格文案（price_text）', () => {
  it('0 显示「免费」而不是「¥0」', () => {
    expect(priceText({ amount: 0, currency: 'CNY' })).toBe('免费');
    expect(priceText({ amount: 0.2, currency: 'CNY' })).toBe('免费');
  });

  it('非零走金额文案规则', () => {
    expect(priceText({ amount: 60, currency: 'CNY' })).toBe('约 ¥60');
    expect(priceText({ amount: 55, currency: 'CNY' })).toBe('¥55');
  });
});

describe('12.1 提前预约文案（advance_text）', () => {
  it('1 天 → "需提前 1 天"（设计稿示例）', () => {
    expect(advanceText(1)).toBe('需提前 1 天');
  });

  it.each([null, 0, -1])('%s 返回 null，模板隐藏该行', (value) => {
    expect(advanceText(value)).toBeNull();
  });

  it('多天正常输出', () => {
    expect(advanceText(7)).toBe('需提前 7 天');
  });
});

describe('12.1 天号标签（day_label）', () => {
  it.each([
    [1, 'DAY 1'],
    [3, 'DAY 3'],
    [14, 'DAY 14'],
  ])('%i → "%s"（不补零）', (dayNumber, expected) => {
    expect(dayLabel(dayNumber)).toBe(expected);
  });
});

describe('12.1 图标名派生', () => {
  it('时段图标为 period-<lowercase>，与 9.1 清单一致', () => {
    expect(periodIconName('MORNING')).toBe('period-morning');
    expect(periodIconName('NIGHT')).toBe('period-night');
  });

  it('设计稿 V1.0 示例的 "sun-morning" 是错的，不应出现', () => {
    // 按 V1.0 示例实现会导致图标查找失败，这条测试守住修正结果
    expect(periodIconName('MORNING')).not.toBe('sun-morning');
  });

  it('交通图标为 transport-<lowercase>，与 9.1 清单一致', () => {
    expect(transportIconName('BOAT')).toBe('transport-boat');
    expect(transportIconName('WALK')).toBe('transport-walk');
  });

  it.each(PERIOD_VALUES)('时段 %s 的图标名可预测且小写', (period) => {
    expect(periodIconName(period)).toBe(`period-${period.toLowerCase()}`);
  });

  it.each(TRANSPORT_MODE_VALUES)('交通方式 %s 的图标名可预测且小写', (mode) => {
    expect(transportIconName(mode)).toBe(`transport-${mode.toLowerCase()}`);
  });
});

describe('12.1 枚举中文映射的穷尽性', () => {
  /**
   * 用 Record<Enum, string> 声明时，漏配是编译错误。这些运行期断言额外守住
   * 「配了但配成空串」的情况 —— 空串会在页面上表现为一处莫名的空白。
   */
  it.each(PERIOD_VALUES)('时段 %s 有非空中文', (period) => {
    expect(PERIOD_LABEL[period]).toMatch(/\S/);
  });

  it.each(MEAL_VALUES)('餐次 %s 有非空中文', (meal) => {
    expect(MEAL_LABEL[meal]).toMatch(/\S/);
  });

  it.each(ROUTE_TYPE_VALUES)('路线类型 %s 有非空中文', (type) => {
    expect(ROUTE_TYPE_LABEL[type]).toMatch(/\S/);
  });

  it.each(PREFERRED_TIME_VALUES)('拍照时间 %s 有非空中文', (time) => {
    expect(PREFERRED_TIME_LABEL[time]).toMatch(/\S/);
  });

  it.each(BOOKING_CATEGORY_VALUES)('预订分类 %s 有非空中文', (category) => {
    expect(BOOKING_CATEGORY_LABEL[category]).toMatch(/\S/);
  });

  it('设计稿 12.1 的具体映射值', () => {
    expect(PERIOD_LABEL.MORNING).toBe('上午');
    expect(PERIOD_LABEL.NOON).toBe('中午');
    expect(PERIOD_LABEL.AFTERNOON).toBe('下午');
    expect(PERIOD_LABEL.EVENING).toBe('傍晚');
    expect(PERIOD_LABEL.NIGHT).toBe('夜间');

    expect(MEAL_LABEL.BREAKFAST).toBe('早餐');
    expect(ROUTE_TYPE_LABEL.RELAXED).toBe('轻松休闲版路线');
    expect(PREFERRED_TIME_LABEL.MORNING).toBe('建议上午');
    expect(BOOKING_CATEGORY_LABEL.RESTAURANT).toBe('餐厅');
  });

  it('中文映射之间不重复（重复会让用户无法区分两类条目）', () => {
    const routeLabels = ROUTE_TYPE_VALUES.map((t) => ROUTE_TYPE_LABEL[t]);
    expect(new Set(routeLabels).size).toBe(routeLabels.length);

    const periodLabels = PERIOD_VALUES.map((p) => PERIOD_LABEL[p]);
    expect(new Set(periodLabels).size).toBe(periodLabels.length);
  });
});

describe('二十章：AI 素材的来源标注', () => {
  it('AI 生成的景点图标注「示意图」', () => {
    expect(sourceNote('AI_GENERATED', 'DESTINATION_PHOTO')).toBe('示意图');
  });

  it('AI 生成的 Hero 不标注（表达主题而非具体地点）', () => {
    expect(sourceNote('AI_GENERATED', 'HERO_BACKGROUND')).toBeNull();
  });

  it('AI 生成的美食图不标注（9.5：真实性要求低于建筑照片）', () => {
    expect(sourceNote('AI_GENERATED', 'FOOD_IMAGE')).toBeNull();
  });

  it('真实照片不标注', () => {
    expect(sourceNote('PLATFORM_LIBRARY', 'DESTINATION_PHOTO')).toBeNull();
    expect(sourceNote('LICENSED_SOURCE', 'DESTINATION_PHOTO')).toBeNull();
  });
});
