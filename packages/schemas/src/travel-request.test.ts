import { describe, expect, it } from 'vitest';

import { TravelRequestUISchema } from './travel-request.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * `TravelRequestUI` 的**结构性**边界（TP-2-03）。
 *
 * 本文件的核心命题只有一条：**schema 不做业务判断**。
 *
 * 这与 travel-plan.ts 是同一条原则，但理由不同。`TravelPlan` 那边是
 * 「schema 太严会把 REPAIRABLE 升级成 BLOCKING，自动修复机制失效」；
 * 这边是错误码粒度：13.7 要求请求校验错误必须带 `field`，
 * 「前端可直接高亮出错表单项」。schema 把 `end_date < start_date` 拒了，
 * 客户端只会拿到 `REQ_SCHEMA_INVALID` —— 一个无法定位到表单项的码。
 */

/*
 * 返回类型刻意标成宽松结构而不是 TravelRequestUI：本文件要构造**结构上
 * 非法**的输入（缺字段、错类型、多字段），而 TravelRequestUI 会在编译期
 * 就拒绝它们 —— 那样就测不到 schema 的运行期行为了。
 */
function base(): Record<string, any> {
  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: 'req-1',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    trip: {
      origin: { text: '上海' },
      destination: { mode: 'FIXED', text: '杭州', allow_multiple_destinations: false },
      dates: { start_date: '2026-04-10', end_date: '2026-04-12', flexibility_days: 0 },
    },
    travelers: { adults: 2, children: [], seniors: [] },
    budget: {
      currency: 'CNY',
      basis: 'TOTAL',
      min: 5_000,
      max: 9_000,
      included_items: ['MEALS'],
    },
    pace: {},
    conditions: [],
    custom_requirements: { raw_text: '' },
    output_preferences: {
      language: 'zh-CN',
      template_id: 'travel_infographic_v1',
      generate_png: true,
      generate_pdf: false,
    },
  };
}

describe('结构合法即通过', () => {
  it('基准请求通过', () => {
    expect(TravelRequestUISchema.safeParse(base()).success).toBe(true);
  });

  it('pace 全部字段可缺省', () => {
    // 5.1：数值字段与 level 都是可选，标准化阶段才补默认值
    const input = { ...base(), pace: {} };
    expect(TravelRequestUISchema.safeParse(input).success).toBe(true);
  });

  it('place_id 可缺省', () => {
    // 用户手输的地名可能没有对应 place_id，此时按 19.1 归一化文本
    expect(TravelRequestUISchema.safeParse(base()).success).toBe(true);
  });
});

describe('schema 刻意不拦的业务冲突（交给 N-01～N-12）', () => {
  it.each([
    [
      'end_date 早于 start_date（N-02）',
      (input: Record<string, any>) => {
        input.trip.dates = {
          start_date: '2026-04-12',
          end_date: '2026-04-10',
          flexibility_days: 0,
        };
      },
    ],
    [
      '天数超过 14（N-03）',
      (input: Record<string, any>) => {
        input.trip.dates = {
          start_date: '2026-04-01',
          end_date: '2026-05-30',
          flexibility_days: 0,
        };
      },
    ],
    [
      'budget.max 小于 min（N-04）',
      (input: Record<string, any>) => {
        input.budget.min = 9_000;
        input.budget.max = 100;
      },
    ],
    [
      'budget.min 为 0（N-04）',
      (input: Record<string, any>) => {
        input.budget.min = 0;
      },
    ],
    [
      '景点上限小于下限（N-05）',
      (input: Record<string, any>) => {
        input.pace = { attractions_per_day_min: 5, attractions_per_day_max: 1 };
      },
    ],
    [
      '出发地与目的地相同（N-06）',
      (input: Record<string, any>) => {
        input.trip.origin = { text: '杭州', place_id: 'cn-hangzhou' };
        input.trip.destination = {
          mode: 'FIXED',
          text: '杭州',
          place_id: 'cn-hangzhou',
          allow_multiple_destinations: false,
        };
      },
    ],
    [
      '人数为 0（N-07）',
      (input: Record<string, any>) => {
        input.travelers = { adults: 0, children: [], seniors: [] };
      },
    ],
    [
      'flexibility_days 非 0（N-09）',
      (input: Record<string, any>) => {
        input.trip.dates.flexibility_days = 3;
      },
    ],
    [
      'allow_multiple_destinations 为 true（N-10）',
      (input: Record<string, any>) => {
        input.trip.destination.allow_multiple_destinations = true;
      },
    ],
    [
      '自定义需求超过 500 字（5.1 要求截断而不是拒绝）',
      (input: Record<string, any>) => {
        input.custom_requirements.raw_text = '博'.repeat(1_200);
      },
    ],
  ])('%s 仍然通过 schema', (_name, mutate) => {
    const input = base();
    mutate(input);
    expect(TravelRequestUISchema.safeParse(input).success).toBe(true);
  });
});

describe('schema 该拦的结构错误', () => {
  it.each([
    [
      'schema_version 不匹配',
      (input: Record<string, any>) => {
        input['schema_version'] = 'travel_request_ui_v2';
      },
    ],
    [
      '缺少 trip',
      (input: Record<string, any>) => {
        delete input['trip'];
      },
    ],
    [
      '日期不是 YYYY-MM-DD',
      (input: Record<string, any>) => {
        (input['trip'] as { dates: { start_date: string } }).dates.start_date = '2026/04/10';
      },
    ],
    [
      'currency 不在枚举内',
      (input: Record<string, any>) => {
        (input['budget'] as { currency: string }).currency = 'USD';
      },
    ],
    [
      'included_items 为空数组',
      (input: Record<string, any>) => {
        (input['budget'] as { included_items: string[] }).included_items = [];
      },
    ],
    [
      '未注册的模板 ID',
      (input: Record<string, any>) => {
        (input['output_preferences'] as { template_id: string }).template_id = 'poster_v9';
      },
    ],
    [
      '条件 code 不在字典内',
      (input: Record<string, any>) => {
        input['conditions'] = [{ code: 'diet.kosher', mode: 'MUST', value: true }];
      },
    ],
    [
      '时区为空',
      (input: Record<string, any>) => {
        input['timezone'] = '';
      },
    ],
    [
      '儿童年龄为负',
      (input: Record<string, any>) => {
        (input['travelers'] as { children: unknown[] }).children = [{ age: -1 }];
      },
    ],
  ])('%s 被拒绝', (_name, mutate) => {
    const input = base();
    mutate(input);
    expect(TravelRequestUISchema.safeParse(input).success).toBe(false);
  });

  it('不接受未知字段之外的类型错误但保留未知字段', () => {
    /*
     * Zod 默认剥离未知字段而不是报错。这里明确记录该行为：
     * 前端多传一个实验性字段不该让整个请求失败，
     * 而剥离后 raw_request 里存的是剥离后的结果 —— 这正是我们要的，
     * 未知字段不会被后续任何逻辑读到，也不会进 Prompt。
     */
    const parsed = TravelRequestUISchema.safeParse({ ...base(), experimental_flag: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'experimental_flag' in parsed.data).toBe(false);
  });
});
