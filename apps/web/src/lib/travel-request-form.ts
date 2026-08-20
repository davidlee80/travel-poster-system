import { MUST_BY_DEFAULT_DOMAINS } from '@tps/presentation';
import {
  SCHEMA_VERSIONS,
  conditionDomain,
  type BudgetBasis,
  type ConditionCode,
  type PaceLevel,
  type TravelRequestUIInput,
} from '@tps/schemas';

/**
 * 表单状态 → `TravelRequestUI`（TP-2-17）。
 *
 * ## 为什么抽成纯函数
 *
 * 组件里直接拼请求体的话，「勾了轮椅但发出去是 SHOULD」这类错误只能靠
 * 端到端测试发现，而端到端测试看不出 mode 的值 —— 界面上都是一个勾。
 * 抽出来之后它是可穷举的纯逻辑。
 */

/**
 * 标签的三态。不在映射里 = 未选。
 *
 * 用三态枚举而不是两个布尔（selected / excluded）：两个布尔有四种组合，
 * 其中「既选中又排除」是无意义状态，而它一定会在某次重构里被构造出来。
 */
export type ConditionStance = 'PREFER' | 'REQUIRE' | 'EXCLUDE';

/**
 * code → 态。用 `Record` 而不是 `Map`：它要进 React state 并被结构化克隆。
 */
export type ConditionSelection = Readonly<Partial<Record<ConditionCode, ConditionStance>>>;

/**
 * 一个三态选择 → 契约里的一条条件。
 *
 * | 界面态 | 颜色       | `mode`   | `value` |
 * | ------ | ---------- | -------- | ------- |
 * | 偏好   | 蓝         | `SHOULD` | `true`  |
 * | 必须   | 绿         | `MUST`   | `true`  |
 * | 不要   | 红删除线   | `MUST`   | `false` |
 *
 * ## 「不要」为什么是 MUST 而不是 SHOULD
 *
 * 用户明确排除某项时那是硬约束 —— V-30 会校验它。用 `SHOULD` 的话它只进
 * 命中率统计（见 plan-rules 的 should 分支），于是一个「不要夜生活」却排了
 * 酒吧的计划会照常放行。「尽量不要」这一态原型里没有，本轮也不造。
 *
 * ## P8 之前这一整条通道是不存在的
 *
 * 旧实现恒传 `value: true`，也就是说 5.1 契约里能表达的「必须不要 X」
 * 在前端根本发不出去。这不是新功能而是补一个缺口。
 */
export function conditionToContract(
  code: ConditionCode,
  stance: ConditionStance,
): { readonly code: ConditionCode; readonly mode: 'MUST' | 'SHOULD'; readonly value: boolean } {
  if (stance === 'EXCLUDE') {
    return { code, mode: 'MUST', value: false };
  }

  /*
   * 无障碍与饮食即使只点了一次（PREFER）也发 MUST：轮椅通行与食物过敏
   * 不是偏好，降级成 SHOULD 后 V-30 不再校验，而计划看起来完全正常。
   */
  const domainIsHard = MUST_BY_DEFAULT_DOMAINS.includes(conditionDomain(code));
  return {
    code,
    mode: stance === 'REQUIRE' || domainIsHard ? 'MUST' : 'SHOULD',
    value: true,
  };
}

export interface TravelRequestFormState {
  readonly origin: string;
  readonly destination: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly adults: number;
  readonly childAges: readonly number[];
  readonly seniorCount: number;
  readonly budgetBasis: BudgetBasis;
  readonly budgetMin: number;
  readonly budgetMax: number;
  readonly paceLevel: PaceLevel;
  readonly conditions: ConditionSelection;
  readonly customText: string;
}

export const INITIAL_FORM_STATE: TravelRequestFormState = {
  origin: '',
  destination: '',
  startDate: '',
  endDate: '',
  adults: 2,
  childAges: [],
  seniorCount: 0,
  budgetBasis: 'PER_PERSON_PER_DAY',
  budgetMin: 500,
  budgetMax: 1_200,
  paceLevel: 'BALANCED',
  conditions: {},
  customText: '',
};

/**
 * 生成 `client_request_id`。
 *
 * 13.8：幂等键含它，用户显式点「重新生成」时客户端**必须换新值**，
 * 否则会拿回旧结果。因此它由每次提交现场生成，而不是挂在组件状态上。
 */
export function newClientRequestId(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * 浏览器时区。
 *
 * N-01 用它判断「今天」。取不到时回退 `Asia/Shanghai` 而不是留空 ——
 * schema 要求非空，留空会让整个请求以 `REQ_SCHEMA_INVALID` 被拒，
 * 而用户完全不知道是时区的问题。
 */
export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone !== undefined && zone.length > 0 ? zone : 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export interface BuildRequestOptions {
  readonly clientRequestId: string;
  readonly timezone: string;
}

/**
 * 表单状态 → 请求体。
 *
 * ## 只发用户真正填过的字段
 *
 * 返回类型是 `TravelRequestUIInput`（= `z.input`）而不是 `TravelRequestUI`
 * （= `z.infer`）：P8 之后契约的必填集只有 11 个字段，其余由 schema 填默认值。
 *
 * 因此这里**刻意不再**发 `locale`、`currency`、`included_items`、
 * `output_preferences`、`mode`、`allow_multiple_destinations`、
 * `flexibility_days` —— 它们的值与 schema 的默认值逐字相同，由前端再写一遍
 * 只会让两处漂移，而漂移的方向通常是「前端比 schema 旧」。
 *
 * 判定哪个字段属于哪一类见 `docs/前端字段清单.md`。
 */
export function buildTravelRequest(
  state: TravelRequestFormState,
  options: BuildRequestOptions,
): TravelRequestUIInput {
  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: options.clientRequestId,
    timezone: options.timezone,

    trip: {
      origin: { text: state.origin.trim() },
      destination: { text: state.destination.trim() },
      dates: { start_date: state.startDate, end_date: state.endDate },
    },

    travelers: {
      adults: state.adults,
      children: state.childAges.map((age) => ({ age })),
      /*
       * 长者只填人数不填年龄：`TravelerSeniorSchema.age` 是可选的，
       * 而年龄在生成里只用于「是否收紧步行上限」（V-14），
       * 那只需要「有没有长者」。多问一个字段不会让计划更好。
       */
      seniors: Array.from({ length: state.seniorCount }, () => ({})),
    },

    /*
     * `basis` 必填而 `currency` 不必：前者决定 min/max 是「人均每天」还是
     * 「全程总额」，猜错会让预算偏差约（人数 × 天数）；后者只有 CNY 一个值。
     */
    budget: {
      basis: state.budgetBasis,
      min: state.budgetMin,
      max: state.budgetMax,
    },

    pace: { level: state.paceLevel },

    /*
     * 三态 → 契约，映射逻辑全在 `conditionToContract` 里（可穷举单测）。
     *
     * `flatMap` + 空数组而不是 `filter` + `map`：`Partial<Record<…>>` 在
     * `exactOptionalPropertyTypes` 下取值类型含 undefined，两步写法要么多一次
     * 类型断言，要么被 `noUncheckedIndexedAccess` 拦住。
     */
    conditions: Object.entries(state.conditions).flatMap(([code, stance]) =>
      stance === undefined ? [] : [conditionToContract(code as ConditionCode, stance)],
    ),

    custom_requirements: { raw_text: state.customText.trim() },
  };
}

/**
 * 提交前的本地必填检查。
 *
 * **不重复实现 N-01～N-12** —— 那是服务端的职责，且错误码与 `field` 都由
 * 它给出（13.7）。这里只拦「空表单」这种连请求都不值得发的情形：
 * 复制一份业务规则到前端，两处必然逐渐分叉，而分叉的表现是
 * 「前端说没问题，后端说不行」。
 */
export function missingRequiredFields(state: TravelRequestFormState): string[] {
  const missing: string[] = [];
  if (state.origin.trim().length === 0) missing.push('出发地');
  if (state.destination.trim().length === 0) missing.push('目的地');
  if (state.startDate.length === 0) missing.push('出发日期');
  if (state.endDate.length === 0) missing.push('返回日期');
  return missing;
}
