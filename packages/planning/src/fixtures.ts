import { SCHEMA_VERSIONS, type TravelRequestUI } from '@tps/schemas';

/**
 * 请求 fixture（测试用）。
 *
 * 用代码生成而不是逐个手写 JSON：N-01～N-12 每条规则都需要一个「只违反
 * 这一条」的输入，手写会产生十几份 90% 相同的对象，而其中任何一份的
 * 无关字段写错都会让测试**因为别的原因**失败 —— 那时最容易得出
 * 「规则实现有问题」的错误结论。
 */

export interface RequestFixtureOverrides {
  readonly trip?: Partial<TravelRequestUI['trip']>;
  readonly travelers?: Partial<TravelRequestUI['travelers']>;
  readonly budget?: Partial<TravelRequestUI['budget']>;
  readonly pace?: Partial<TravelRequestUI['pace']>;
  readonly conditions?: TravelRequestUI['conditions'];
  readonly custom_requirements?: Partial<TravelRequestUI['custom_requirements']>;
  readonly output_preferences?: Partial<TravelRequestUI['output_preferences']>;
  readonly timezone?: string;
  /**
   * P9：九步问卷答案。
   *
   * **不做浅合并，也不给默认值。** 基准夹具刻意不带 `planner_profile` ——
   * 它代表 P8 及之前的客户端，而 N-10/N-13/N-14 三条规则的判定条件都是
   * 「发了问卷才检查」。给它一个默认值会让基准夹具突然要过授权与证件校验，
   * 而那与那三条规则想表达的向后兼容正好相反。
   */
  readonly planner_profile?: TravelRequestUI['planner_profile'];
}

/**
 * 一份**全部规则都通过**的基准请求。
 *
 * 日期用固定值而不是 `new Date()`：随当前时间变化的 fixture 会让测试
 * 在某些日期突然失败（例如跨年、月末），而那种失败与代码改动无关。
 * N-01 的「今天」由测试显式传入，两者配套。
 */
export const FIXTURE_TODAY = '2026-04-01';

export function makeRequestFixture(overrides: RequestFixtureOverrides = {}): TravelRequestUI {
  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: 'req-client-001',
    locale: 'zh-CN',
    timezone: overrides.timezone ?? 'Asia/Shanghai',

    trip: {
      origin: { text: '上海', place_id: 'cn-shanghai' },
      destination: {
        mode: 'FIXED',
        text: '杭州',
        place_id: 'cn-hangzhou',
        allow_multiple_destinations: false,
      },
      dates: { start_date: '2026-04-10', end_date: '2026-04-14', flexibility_days: 0 },
      /*
       * P8：夹具是**解析后**的形态（`TravelRequestUI` = `z.infer`），
       * 因此带默认值的字段在这里是必填的 —— 漏写是编译错误。
       * 空数组 = 尚无预订，与基准夹具「什么都没订」的设定一致。
       */
      existing_bookings: [],
      ...overrides.trip,
    },

    travelers: { adults: 2, children: [{ age: 7 }], seniors: [], ...overrides.travelers },

    budget: {
      currency: 'CNY',
      basis: 'PER_PERSON_PER_DAY',
      min: 800,
      max: 1500,
      included_items: ['ACCOMMODATION', 'MEALS', 'LOCAL_TRANSPORT', 'TICKETS'],
      ...overrides.budget,
    },

    pace: {
      level: 'RELAXED',
      attractions_per_day_min: 2,
      attractions_per_day_max: 3,
      walking_limit_km: 5,
      earliest_departure_time: '09:00',
      ...overrides.pace,
    },

    conditions: overrides.conditions ?? [
      { code: 'interest.history_culture', mode: 'SHOULD', value: true },
      { code: 'accommodation.elevator', mode: 'MUST', value: true },
    ],

    custom_requirements: {
      raw_text: '希望安排运河、博物馆和本地美食，晚上不要太晚。',
      ...overrides.custom_requirements,
    },

    output_preferences: {
      language: 'zh-CN',
      template_id: 'ink_paper_v1',
      generate_png: true,
      generate_pdf: true,
      ...overrides.output_preferences,
    },

    ...(overrides.planner_profile === undefined
      ? {}
      : { planner_profile: overrides.planner_profile }),
  };
}
