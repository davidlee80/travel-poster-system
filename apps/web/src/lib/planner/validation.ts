import { plannerField, type PlannerFieldId } from '@tps/schemas';

import { readAnswer, type PlannerState } from './state';

/**
 * 字段级校验（字段表「校验/验收规则」列）。
 *
 * ## 只做本地可判定的规则
 *
 * 「必须可解析到城市+国家」「品牌为空不限制」这类需要外部数据或本身不构成
 * 错误的条目不在这里 —— 前者要地点服务，后者不是规则。这里只留
 * **纯本地、能立刻在字段下方给出一句话的**校验。
 *
 * ## 不重复实现 N-01～N-12
 *
 * 服务端的 N-xx 是权威，且它的错误码带 `field`（13.7）。前端这一层的目的不同：
 * 让用户在**离开字段时**就看到问题，而不是提交后被拒。因此两边会有重叠
 * （日期倒置两处都查），但重叠的那几条口径必须一致 —— 不一致的表现是
 * 「前端说没问题，后端说不行」。
 *
 * ## 「无」与其他选项互斥为什么不在这里
 *
 * 字段表有五处写着「『无』与其他选项互斥」。契约里这五个字段**都没有 NONE
 * 成员**，空数组就是「无」（见 planner-profile.ts 各处注释）。结构上就不可能
 * 出现 `['NONE', 'LODGING']`，因此不需要一条校验去拦 ——
 * 加了反而会让读者以为那种值可能存在。
 */

type Validator = (state: PlannerState) => string | null;

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const VALIDATORS: Partial<Record<PlannerFieldId, Validator>> = {
  'PV2-01-003': (s) => {
    const list = asArray(readAnswer(s.answers, 'trip.destinations'));
    return list.length === 0 ? '至少填写 1 个目的地。' : null;
  },

  'PV2-01-004': (s) => {
    const dates = asRecord(readAnswer(s.answers, 'trip.dates'));
    const start = str(dates['start_date']);
    const end = str(dates['end_date']);
    if (start.length === 0 || end.length === 0) return null;
    return end < start ? '返回日期不能早于出发日期。' : null;
  },

  'PV2-01-006': (s) => {
    const values = asArray(asRecord(readAnswer(s.answers, 'profile.trip_purposes'))['values']);
    if (values.length === 0) return null;
    return values.length > 4 ? '最多选择 4 项旅行目的。' : null;
  },

  'PV2-01-007': (s) => {
    const values = asArray(asRecord(readAnswer(s.answers, 'profile.top_goals'))['values']);
    if (values.length === 0) return null;
    return values.length > 3 ? '最重要的事最多排 3 项。' : null;
  },

  'PV2-01-009': (s) => {
    const orders = asArray(readAnswer(s.answers, 'trip.locked_orders'));
    const incomplete = orders.filter((order) => {
      const record = asRecord(order);
      return (
        str(record['name']).trim().length === 0 ||
        str(record['datetime_text']).trim().length === 0 ||
        str(record['place_text']).trim().length === 0
      );
    });
    return incomplete.length > 0 ? `还有 ${incomplete.length} 张订单缺名称、时间或地点。` : null;
  },

  'PV2-02-002': (s) => {
    /*
     * 人数与卡片数不一致时报出**差多少**而不是「格式错误」：
     * 规范 12 对房型配置提了同样的要求（「显示尚有 N 人未分配」），
     * 同一条原则适用于这里 —— 用户看到「还差 2 位」才知道要做什么。
     */
    const count = num(readAnswer(s.answers, 'travelers.count'));
    const profiles = asArray(readAnswer(s.answers, 'travelers.profiles'));
    if (count === undefined || profiles.length === 0) return null;
    if (profiles.length < count) return `还有 ${count - profiles.length} 位旅行者未填写。`;
    if (profiles.length > count) return `比同行人数多了 ${profiles.length - count} 位。`;

    const missing = profiles.filter((p) => {
      const record = asRecord(p);
      return record['relation'] === undefined || record['age_band'] === undefined;
    });
    return missing.length > 0 ? `还有 ${missing.length} 位缺同行关系或年龄段。` : null;
  },

  'PV2-03-003': (s) => {
    const range = asRecord(readAnswer(s.answers, 'budget.target_range'));
    const min = num(range['min']);
    const max = num(range['max']);
    if (min === undefined || max === undefined) return null;
    return max < min ? '预算上限需要不低于下限。' : null;
  },

  'PV2-03-005': (s) => {
    const cap = asRecord(readAnswer(s.answers, 'budget.hard_cap'));
    if (cap['enabled'] !== true) return null;
    const amount = num(cap['amount']);
    if (amount === undefined) return '开启硬上限后需要填写金额。';
    const min = num(asRecord(readAnswer(s.answers, 'budget.target_range'))['min']);
    return min !== undefined && amount < min ? '硬上限不应低于目标预算下限。' : null;
  },

  'PV2-04-002': (s) => {
    const window = asRecord(readAnswer(s.answers, 'pace.daily_window'));
    const start = str(window['start']);
    const end = str(window['end']);
    if (start.length === 0 || end.length === 0) return null;
    /*
     * 允许跨午夜（规范 10：「如包含夜生活，可允许跨午夜并以明确文案提示」），
     * 因此 end < start **不是错误**，只是需要提示。返回 null 而不是错误 ——
     * 那句提示由控件的 hint 承担，不占错误位。
     */
    return null;
  },

  'PV2-04-006': (s) => {
    const rest = asRecord(readAnswer(s.answers, 'pace.rest_window'));
    if (rest['enabled'] !== true) return null;
    const window = asRecord(rest['window']);
    const start = str(window['start']);
    const end = str(window['end']);
    if (start.length === 0 || end.length === 0) return '需要填写午休的开始与结束时间。';
    return end <= start ? '午休结束时间需要晚于开始时间。' : null;
  },

  'PV2-06-003': (s) => {
    /* 规范 12：房间配置必须覆盖全部旅行者，错误文案要说「尚有 N 人未分配」 */
    const rooms = asArray(readAnswer(s.answers, 'lodging.room_configuration'));
    if (rooms.length === 0) return null;
    const capacity = rooms.reduce<number>(
      (sum, room) => sum + (num(asRecord(room)['capacity']) ?? 0),
      0,
    );
    const travelers = num(readAnswer(s.answers, 'travelers.count')) ?? 0;
    return capacity < travelers ? `尚有 ${travelers - capacity} 人未分配房间。` : null;
  },

  'PV2-06-004': (s) => {
    const range = asRecord(readAnswer(s.answers, 'lodging.nightly_budget'));
    const min = num(range['min']);
    const max = num(range['max']);
    if (min === undefined || max === undefined) return null;
    return max < min ? '每晚预算上限需要不低于下限。' : null;
  },

  'PV2-07-004': (s) => {
    const details = asRecord(readAnswer(s.answers, 'food.allergy_details'));
    const allergens = asArray(details['allergens']);
    if (allergens.length === 0) return '请至少填写一种过敏原与严重程度。';
    const incomplete = allergens.filter((entry) => {
      const record = asRecord(entry);
      return str(record['allergen']).trim().length === 0 || record['severity'] === undefined;
    });
    return incomplete.length > 0 ? '每种过敏原都需要填写严重程度。' : null;
  },

  'PV2-07-008': (s) => {
    /*
     * 必去项的日期限制必须落在旅行窗口内（规范 18.1 的第三类冲突）。
     *
     * 只查 `must_do[].date_constraint` —— 它是结构化的 `YYYY-MM-DD`。
     * 已有订单（PV2-01-009）的时间**查不了**：契约里它是自由文本
     * （`datetime_text`，因为用户手上的凭证形态各异，「10/05 10:00 起飞」），
     * 从中解析日期需要一个容错的中文日期解析器，而解析错的后果是
     * 报一个用户看不懂的冲突。那一项由生成侧的 LOCKED 约束在 Prompt 里
     * 交给模型判断，并在 `assumptions` 里说明。
     */
    const dates = asRecord(readAnswer(s.answers, 'trip.dates'));
    const start = str(dates['start_date']);
    const end = str(dates['end_date']);
    if (start.length === 0 || end.length === 0) return null;

    const outside = asArray(readAnswer(s.answers, 'interests.must_do')).filter((entry) => {
      const date = str(asRecord(entry)['date_constraint']);
      return date.length > 0 && (date < start || date > end);
    });
    return outside.length === 0
      ? null
      : `有 ${outside.length} 项的日期不在 ${start} 至 ${end} 之间。`;
  },

  'PV2-07-007': (s) => {
    /* 字段表：Top 3 必须从已选兴趣中选择 */
    const tags = asArray(readAnswer(s.answers, 'interests.tags')).map((t) => str(t));
    const top3 = asArray(readAnswer(s.answers, 'interests.top3')).map((t) => str(t));
    const outside = top3.filter((code) => !tags.includes(code));
    return outside.length > 0 ? '排序只能从你已选的兴趣里挑。' : null;
  },

  'PV2-09-004': (s) => {
    const text = str(readAnswer(s.answers, 'profile.additional_notes'));
    return text.length > 500 ? `超出 ${text.length - 500} 字，建议控制在 500 字内。` : null;
  },
};

/** 这个字段现在的校验错误。`null` = 通过 */
export function validateField(state: PlannerState, fieldId: PlannerFieldId): string | null {
  const validator = VALIDATORS[fieldId];
  return validator === undefined ? null : validator(state);
}

/** 有校验规则的字段。测试用它对照字段表 */
export const VALIDATED_FIELD_IDS: readonly PlannerFieldId[] = Object.keys(
  VALIDATORS,
) as readonly PlannerFieldId[];

/** 该字段是否声明了校验规则。Dev Mode 显示它 */
export function hasValidator(fieldId: PlannerFieldId): boolean {
  return VALIDATORS[fieldId] !== undefined;
}

/** 全部字段的校验错误，供 Step 状态机与生成前校验遍历 */
export function invalidFields(
  state: PlannerState,
  triggered: readonly PlannerFieldId[],
): readonly { readonly fieldId: PlannerFieldId; readonly message: string }[] {
  const out: { fieldId: PlannerFieldId; message: string }[] = [];
  for (const fieldId of triggered) {
    /*
     * 只查已触发字段。未触发字段的草稿可能是上游改动后残留的
     * （规范 6 的 inactive），拿它报错会让用户看到一个不存在的字段出错。
     */
    if (plannerField(fieldId).level === 'POST_PLAN') continue;
    const message = validateField(state, fieldId);
    if (message !== null) out.push({ fieldId, message });
  }
  return out;
}
