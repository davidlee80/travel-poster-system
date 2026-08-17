import { MUST_BY_DEFAULT_DOMAINS } from '@tps/presentation';
import {
  SCHEMA_VERSIONS,
  conditionDomain,
  type BudgetBasis,
  type ConditionCode,
  type PaceLevel,
  type TravelRequestUI,
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
  readonly conditions: readonly ConditionCode[];
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
  conditions: [],
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

export function buildTravelRequest(
  state: TravelRequestFormState,
  options: BuildRequestOptions,
): TravelRequestUI {
  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: options.clientRequestId,
    locale: 'zh-CN',
    timezone: options.timezone,

    trip: {
      origin: { text: state.origin.trim() },
      destination: {
        mode: 'FIXED',
        text: state.destination.trim(),
        // V1 不支持多目的地（N-10），因此这里是常量而不是表单项
        allow_multiple_destinations: false,
      },
      dates: {
        start_date: state.startDate,
        end_date: state.endDate,
        // V1 不支持弹性日期（N-09）
        flexibility_days: 0,
      },
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

    budget: {
      currency: 'CNY',
      basis: state.budgetBasis,
      min: state.budgetMin,
      max: state.budgetMax,
      included_items: ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
    },

    pace: { level: state.paceLevel },

    /*
     * 5.1：`mode` 决定是硬约束还是软约束，而 V-30 只校验前者。
     * 无障碍与饮食默认为 MUST —— 轮椅通行与食物过敏不是偏好。
     */
    conditions: state.conditions.map((code) => ({
      code,
      mode: MUST_BY_DEFAULT_DOMAINS.includes(conditionDomain(code)) ? 'MUST' : 'SHOULD',
      value: true,
    })),

    custom_requirements: { raw_text: state.customText.trim() },

    output_preferences: {
      language: 'zh-CN',
      template_id: 'travel_infographic_v1',
      generate_png: true,
      generate_pdf: true,
    },
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
