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

// ── P8：必填集收缩到 11 个字段 ────────────────────────────────

/**
 * 只带 11 个必填字段的请求。
 *
 * 这是「前端可任意替换」的最低门槛：任何 HTML 模板只要凑出这 11 项就能生成计划，
 * 其余 56 个附加项由 schema 填默认值（判定过程见 docs/前端字段清单.md）。
 */
function minimal(): Record<string, any> {
  return {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: 'minimal-1',
    timezone: 'Asia/Shanghai',
    trip: {
      origin: { text: '上海' },
      destination: { text: '杭州' },
      dates: { start_date: '2026-04-10', end_date: '2026-04-12' },
    },
    travelers: { adults: 2 },
    budget: { basis: 'PER_PERSON_PER_DAY', min: 300, max: 800 },
  };
}

describe('P8：最小必填集（11 个字段）', () => {
  it('最小请求通过校验', () => {
    const result = TravelRequestUISchema.safeParse(minimal());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('缺省项被填成默认值，下游拿到的形状与全量请求一致', () => {
    /*
     * 用 `.default()` 而不是 `.optional()` 的全部理由都在这条断言里：
     * 下游（normalize.ts）直接读 `ui.travelers.children.length`，
     * 改成 optional 会让那一行在运行期炸，而不是编译期。
     */
    const parsed = TravelRequestUISchema.parse(minimal());

    expect(parsed.locale).toBe('zh-CN');
    expect(parsed.trip.destination.mode).toBe('FIXED');
    expect(parsed.trip.destination.allow_multiple_destinations).toBe(false);
    expect(parsed.trip.dates.flexibility_days).toBe(0);
    expect(parsed.travelers.children).toEqual([]);
    expect(parsed.travelers.seniors).toEqual([]);
    expect(parsed.budget.currency).toBe('CNY');
    expect(parsed.budget.included_items).toEqual([
      'ACCOMMODATION',
      'MEALS',
      'LOCAL_TRANSPORT',
      'TICKETS',
    ]);
    expect(parsed.pace).toEqual({});
    expect(parsed.conditions).toEqual([]);
    expect(parsed.custom_requirements.raw_text).toBe('');
    expect(parsed.output_preferences).toEqual({
      language: 'zh-CN',
      template_id: 'travel_infographic_v1',
      generate_png: true,
      generate_pdf: true,
    });
  });

  it('11 个必填字段各缺一个都被拒，且 issue 的 path 指向它', () => {
    /*
     * 逐个删而不是只测一个：默认值加错位置的典型症状是「本该必填的字段也被
     * 填了默认值」—— 那时请求照常通过，而生成用的是猜的值，没有任何报错。
     *
     * 断言 path 而不只断言失败：13.7 要求错误能定位到表单项，
     * 而 `error.issues[].path` 正是 API 层 `field` 的来源。
     */
    const paths: readonly (readonly string[])[] = [
      ['schema_version'],
      ['client_request_id'],
      ['timezone'],
      ['trip', 'origin', 'text'],
      ['trip', 'destination', 'text'],
      ['trip', 'dates', 'start_date'],
      ['trip', 'dates', 'end_date'],
      ['travelers', 'adults'],
      ['budget', 'basis'],
      ['budget', 'min'],
      ['budget', 'max'],
    ];

    expect(paths, '必填集是 11 个字段').toHaveLength(11);

    for (const path of paths) {
      const broken = minimal();
      let cursor: Record<string, any> = broken;
      for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, any>;
      delete cursor[path[path.length - 1]!];

      const result = TravelRequestUISchema.safeParse(broken);
      expect(result.success, `删掉 ${path.join('.')} 后仍然通过了校验`).toBe(false);
      if (!result.success) {
        const target = path.join('.');
        expect(
          result.error.issues.some((issue) => issue.path.join('.') === target),
          `${target} 的错误没有指向它自己：${JSON.stringify(result.error.issues)}`,
        ).toBe(true);
      }
    }
  });

  it('全量请求仍然合法（放宽是向后兼容的）', () => {
    // 反证：把必填改成带默认值不该让任何现存请求失效
    expect(TravelRequestUISchema.safeParse(base()).success).toBe(true);
  });

  it('三个新增的附加字段可缺省，缺省时不出现在解析结果里', () => {
    /*
     * `existing_bookings` 有默认值（空数组 = 尚无预订），另两个是纯 optional：
     * 「没选档位」与「档位是经济」不是一回事，给 `tier` 一个默认值会让前者
     * 变得无法表达，而模型会据此调整选点取向。
     */
    const parsed = TravelRequestUISchema.parse(minimal());
    expect(parsed.trip.existing_bookings).toEqual([]);
    expect(parsed.budget.tier).toBeUndefined();
    expect(parsed.pace.intensity).toBeUndefined();
  });

  it('三个新增字段的取值被正确接受', () => {
    const input = minimal();
    input['trip'] = { ...(input['trip'] as object), existing_bookings: ['LODGING', 'TICKETS'] };
    input['budget'] = { ...(input['budget'] as object), tier: 'QUALITY' };
    input['pace'] = { intensity: 4 };

    const parsed = TravelRequestUISchema.parse(input);
    expect(parsed.trip.existing_bookings).toEqual(['LODGING', 'TICKETS']);
    expect(parsed.budget.tier).toBe('QUALITY');
    expect(parsed.pace.intensity).toBe(4);
  });

  it.each([
    ['existing_bookings 含未知取值', 'trip', { existing_bookings: ['FLIGHT'] }],
    ['tier 不在枚举内', 'budget', { tier: 'BACKPACKER' }],
  ])('%s 被拒绝', (_name, key, patch) => {
    const input = minimal();
    input[key] = { ...(input[key] as object), ...patch };
    expect(TravelRequestUISchema.safeParse(input).success).toBe(false);
  });

  it.each([0, 6, 2.5])('intensity=%s 越界或非整数被拒绝', (intensity) => {
    /*
     * 1～5 对应原型滑块的五档。越界值不能静默截断：`intensity` 与 `level`
     * 并存且以数值为准（5.1），一个被截断的 6 会让「特种兵」变成别的东西
     * 而用户看不到任何提示。
     */
    const input = minimal();
    input['pace'] = { intensity };
    expect(TravelRequestUISchema.safeParse(input).success).toBe(false);
  });

  it('显式传空的 included_items 仍被拒', () => {
    /*
     * `.default()` 只在键**缺省**时生效，显式 `[]` 会照常走 `.min(1)`。
     * 这正是想要的语义：可以不传，但传了就不能是「预算不含任何开支」——
     * 后者让 min/max 失去意义，而它不是一个用户会有意表达的诉求。
     */
    const input = minimal();
    input['budget'] = { ...(input['budget'] as object), included_items: [] };
    expect(TravelRequestUISchema.safeParse(input).success).toBe(false);
  });
});
