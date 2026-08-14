import type {
  BookingCategory,
  BudgetBucket,
  Currency,
  Meal,
  Money,
  Period,
  PreferredTime,
  RouteType,
  TransportMode,
} from '@tps/schemas';

/**
 * 派生字段生成规则（TP-1-08，设计稿 12.1）。
 *
 * ViewModel 中大量字段是把 TravelPlan 的结构化值转成中文展示文案。
 * V1.0 只给了示例值没给规则，两个实现者会产出两种结果。
 *
 * 本模块全部是**纯函数**，无 IO、无随机、无时间依赖，因此可以表驱动单测
 * 逐条对照 12.1 的规则表 —— 这是这些规则唯一可靠的固化方式。
 */

// ── 枚举中文映射 ────────────────────────────────────────────

/**
 * 用 `Record<Enum, string>` 而不是查表函数 + default：
 * 枚举新增值时 TypeScript 会报「缺少属性」，而 default 分支会静默返回兜底值。
 * 静默兜底在展示层的表现是页面上出现一个莫名的默认词，很难被发现。
 */
export const PERIOD_LABEL: Record<Period, string> = {
  MORNING: '上午',
  NOON: '中午',
  AFTERNOON: '下午',
  EVENING: '傍晚',
  NIGHT: '夜间',
};

export const MEAL_LABEL: Record<Meal, string> = {
  BREAKFAST: '早餐',
  LUNCH: '午餐',
  DINNER: '晚餐',
  SNACK: '小食',
};

export const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  RELAXED: '轻松休闲版路线',
  CLASSIC: '经典必看版路线',
  DEEP: '深度探索版路线',
  FAMILY: '亲子友好版路线',
};

export const PREFERRED_TIME_LABEL: Record<PreferredTime, string> = {
  MORNING: '建议上午',
  AFTERNOON: '建议下午',
  GOLDEN_HOUR: '建议黄昏',
  NIGHT: '建议夜间',
};

export const BOOKING_CATEGORY_LABEL: Record<BookingCategory, string> = {
  RESTAURANT: '餐厅',
  ATTRACTION: '景点',
  ACCOMMODATION: '住宿',
  TRANSPORT: '交通',
  SHOW: '演出',
};

export const BUDGET_BUCKET_LABEL: Record<BudgetBucket, string> = {
  TICKET: '门票',
  TRANSPORT: '交通',
  MEAL: '餐饮',
  OTHER: '其他',
};

// ── 图标名派生 ──────────────────────────────────────────────

/**
 * 时段图标名。`period-morning` 形式，对应 9.1 的时段图标文件。
 *
 * 注意：设计稿 V1.0 的 ViewModel 示例里写的是 `sun-morning`，与 12.1 的规则
 * 和 9.1 的清单都不一致，按原值实现会直接导致图标查找失败。已在 V1.2 修正。
 */
export function periodIconName(period: Period): string {
  return `period-${period.toLowerCase()}`;
}

/** 交通图标名。`transport-boat` 形式，对应 9.1 的交通图标文件。 */
export function transportIconName(mode: TransportMode): string {
  return `transport-${mode.toLowerCase()}`;
}

// ── 时长文案 ────────────────────────────────────────────────

/**
 * 12.1 时长文案规则：
 *
 *   m < 60            → `约 ${m} 分钟`
 *   m 是 60 的整数倍   → `建议 ${m / 60} 小时`
 *   其余              → `建议 ${floor(m/60)}～${ceil(m/60)} 小时`
 *
 * 非正数返回空串交由调用方决定是否隐藏 —— 编造一个「约 0 分钟」比不显示更糟。
 */
export function durationText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';

  const m = Math.round(minutes);
  if (m < 60) return `约 ${m} 分钟`;
  if (m % 60 === 0) return `建议 ${m / 60} 小时`;

  return `建议 ${Math.floor(m / 60)}～${Math.ceil(m / 60)} 小时`;
}

// ── 金额文案 ────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<Currency, string> = {
  CNY: '¥',
};

/**
 * 12.1 金额文案规则：
 *
 *   a === 0                 → `${symbol}0`
 *   a 是 10 的整数倍且 > 0   → `约 ${symbol}${a}`
 *   其余                    → `${symbol}${round(a)}`
 *
 * 「约」只用于 10 的整数倍 —— 那是估算值的特征；精确值不加「约」，
 * 否则用户会怀疑所有数字都不可信。
 *
 * 展示一律四舍五入到整数，底层保留两位小数。
 */
export function amountText(money: Money): string {
  const symbol = CURRENCY_SYMBOL[money.currency];
  const rounded = Math.round(money.amount);

  if (rounded === 0) return `${symbol}0`;
  if (rounded > 0 && rounded % 10 === 0) return `约 ${symbol}${rounded}`;

  return `${symbol}${rounded}`;
}

/** 12.1 总额文案：`约 ¥105 / 人` */
export function totalText(total: number, currency: Currency): string {
  const symbol = CURRENCY_SYMBOL[currency];
  return `约 ${symbol}${Math.round(total)} / 人`;
}

/** 门票价格文案：0 显示「免费」（12.1） */
export function priceText(price: Money): string {
  return Math.round(price.amount) === 0 ? '免费' : amountText(price);
}

/** 提前预约文案：0 或 null 返回 null，模板隐藏该行（12.1） */
export function advanceText(advanceDays: number | null): string | null {
  if (advanceDays === null || advanceDays <= 0) return null;
  return `需提前 ${Math.round(advanceDays)} 天`;
}

/** `DAY 3`，不补零（12.1） */
export function dayLabel(dayNumber: number): string {
  return `DAY ${dayNumber}`;
}

/**
 * AI 生成的**景点类**代表图需标注「示意图」（设计稿二十章、9.4）。
 *
 * Hero 氛围图不标注 —— 它表达主题而非具体地点，用户不会把它误认为实拍。
 * 美食图同样不标注：设计稿 9.5 明确美食图的真实性要求低于建筑照片。
 */
export function sourceNote(
  sourceType: string,
  role: 'HERO_BACKGROUND' | 'DESTINATION_PHOTO' | 'FOOD_IMAGE',
): string | null {
  return sourceType === 'AI_GENERATED' && role === 'DESTINATION_PHOTO' ? '示意图' : null;
}
