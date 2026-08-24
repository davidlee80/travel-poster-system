import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PLANNER_FIELDS } from './planner-fields.js';
import { PlannerProfileSchema } from './planner-profile.js';
import { TravelRequestUISchema } from './travel-request.js';
import { SCHEMA_VERSIONS } from './versions.js';

/**
 * 本文件守的是 `planner-profile.ts` 头部那条规则：
 *
 *     76 个字段的载荷路径 === `planner_profile.` + api_key
 *
 * 逐个 api_key 走 schema 而不是抽查几个：这条规则的价值全在于「没有例外」，
 * 而有一个例外就意味着后端派生约束时要查别名表 —— 那张表是第二个真相源。
 */

/**
 * 剥掉 `.optional()` / `.default()` 外壳，拿到里面的 schema。
 *
 * `as z.ZodTypeAny`：Zod 4 里 `def.innerType` 的静态类型是 `$ZodType`
 * （内部基类），它缺 `ZodType` 的 `def` / `type` 等成员，因此不加断言无法继续
 * 循环剥壳。运行期形状是对的 —— 断言之下紧接着的 `instanceof` 判断会兜住
 * 任何意外类型。
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current.def.innerType as z.ZodTypeAny;
  }
  return current;
}

function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const inner = unwrap(schema);
  return inner instanceof z.ZodObject ? inner.shape : null;
}

describe('planner_profile 与 76 个 api_key 的绑定', () => {
  it('每个 api_key 都在 planner_profile 下有对应路径', () => {
    const topShape = objectShape(PlannerProfileSchema);
    expect(topShape).not.toBeNull();

    const missing: string[] = [];
    for (const field of PLANNER_FIELDS) {
      const [block, leaf] = field.api_key.split('.');
      const blockSchema = topShape?.[block ?? ''];
      if (blockSchema === undefined) {
        missing.push(`${field.field_id} 缺子块 ${String(block)}`);
        continue;
      }
      const blockShape = objectShape(blockSchema);
      if (blockShape === null || blockShape[leaf ?? ''] === undefined) {
        missing.push(`${field.field_id} 缺字段 ${field.api_key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('planner_profile 的子块集合与 api_key 前缀集合完全相同', () => {
    const topShape = objectShape(PlannerProfileSchema);
    const blocks = new Set(Object.keys(topShape ?? {}));
    const prefixes = new Set(PLANNER_FIELDS.map((field) => field.api_key.split('.')[0]));

    // 双向：多出来的块是没人用的死结构，少的块上一条断言已经报了
    expect([...blocks].sort()).toEqual([...prefixes].sort());
    expect(blocks.size).toBe(19);
  });

  it('每个子块里没有 76 个字段之外的叶子键', () => {
    /*
     * 反向断言。少一个叶子由第一条测试报出，多一个叶子只有这里能报 ——
     * 而多出来的叶子意味着某个值被存进了一个没有 field_id 的位置，
     * 于是它既不参与完成度，也无法被摘要 chip 回跳。
     */
    const topShape = objectShape(PlannerProfileSchema) ?? {};
    const expected = new Map<string, Set<string>>();
    for (const field of PLANNER_FIELDS) {
      const [block, leaf] = field.api_key.split('.');
      const set = expected.get(block ?? '') ?? new Set<string>();
      set.add(leaf ?? '');
      expected.set(block ?? '', set);
    }

    for (const [block, blockSchema] of Object.entries(topShape)) {
      const actual = new Set(Object.keys(objectShape(blockSchema) ?? {}));
      expect([...actual].sort(), `子块 ${block} 的叶子键与字段表不一致`).toEqual(
        [...(expected.get(block) ?? new Set())].sort(),
      );
    }
  });
});

describe('规范 4.3：用户自报与核验结论分开', () => {
  /**
   * 护照、签证、保险、自驾资格、用药状态五处的用户输入都必须包在
   * `user_reported` 里。裸 enum 在下游看起来与核验结论毫无区别，
   * 而误当结论用的后果是「系统告诉用户签证没问题」。
   */
  const cases: readonly [string, string][] = [
    ['documents', 'passport_status'],
    ['documents', 'visa_status'],
    ['insurance', 'status'],
    ['transport', 'self_drive'],
    ['special', 'medication_status'],
  ];

  for (const [block, leaf] of cases) {
    it(`${block}.${leaf} 的载荷里有 user_reported`, () => {
      const topShape = objectShape(PlannerProfileSchema) ?? {};
      const blockShape = objectShape(topShape[block] as z.ZodTypeAny) ?? {};
      const leafShape = objectShape(blockShape[leaf] as z.ZodTypeAny);
      expect(leafShape, `${block}.${leaf} 不是对象`).not.toBeNull();
      expect(Object.keys(leafShape ?? {})).toContain('user_reported');
    });
  }
});

describe('planner_profile 的解析行为', () => {
  it('空对象合法 —— 用户可以在任何一步中途离开并提交草稿', () => {
    expect(PlannerProfileSchema.safeParse({}).success).toBe(true);
  });

  it('部分填写合法 —— 未触发的字段不必出现', () => {
    const result = PlannerProfileSchema.safeParse({
      trip: { origin: { text: '上海' }, destination_status: 'SHORTLISTED' },
      travelers: { count: 2 },
    });
    expect(result.success).toBe(true);
  });

  it('三态标签保留 code 与态', () => {
    const result = PlannerProfileSchema.safeParse({
      transport: { intercity_modes: [{ code: 'transport.rail', stance: 'REQUIRE' }] },
    });
    expect(result.success).toBe(true);
    expect(result.data?.transport?.intercity_modes?.[0]?.stance).toBe('REQUIRE');
  });

  it('配置中心新发布的条件码能通过 —— code 是域前缀正则而不是字面量联合', () => {
    /*
     * 这一条直接对应「陷阱 1」的反面：配置中心可以在七个既有域下发布新码，
     * 写死联合会让新标签在契约层就被拒，而症状是「配置改完了，前端能点，
     * 提交报 REQ_SCHEMA_INVALID」。
     */
    const result = PlannerProfileSchema.safeParse({
      lodging: { amenities: [{ code: 'accommodation.brand_new_amenity', stance: 'PREFER' }] },
    });
    expect(result.success).toBe(true);
  });

  it('域前缀之外的码仍然被拒', () => {
    const result = PlannerProfileSchema.safeParse({
      lodging: { amenities: [{ code: 'unknown_domain.whatever', stance: 'PREFER' }] },
    });
    expect(result.success).toBe(false);
  });

  it('排序类字段用数组顺序表达排名，且有上限', () => {
    const ok = PlannerProfileSchema.safeParse({
      lodging: { location_priorities: ['TRANSIT_CONVENIENT', 'QUIET', 'WALK_TO_SIGHTS'] },
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.lodging?.location_priorities?.[0]).toBe('TRANSIT_CONVENIENT');

    const tooMany = PlannerProfileSchema.safeParse({
      lodging: {
        location_priorities: ['TRANSIT_CONVENIENT', 'QUIET', 'WALK_TO_SIGHTS', 'NIGHTLIFE'],
      },
    });
    expect(tooMany.success).toBe(false);
  });

  it('开关型字段关掉时仍能保留已填值（规范 6 的「值保留」）', () => {
    const result = PlannerProfileSchema.safeParse({
      budget: { hard_cap: { enabled: false, amount: 30_000 } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.budget?.hard_cap?.amount).toBe(30_000);
  });
});

describe('挂到 TravelRequestUI 之后的向后兼容', () => {
  const minimal = {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: 'test-1',
    timezone: 'Asia/Shanghai',
    trip: {
      origin: { text: '上海' },
      destination: { text: '杭州' },
      dates: { start_date: '2026-09-01', end_date: '2026-09-03' },
    },
    travelers: { adults: 2 },
    budget: { basis: 'PER_PERSON_PER_DAY', min: 500, max: 1_200 },
  } as const;

  it('契约版本号未递增 —— 本轮全部是可选新增', () => {
    expect(SCHEMA_VERSIONS.travelRequestUi).toBe('travel_request_ui_v1');
  });

  it('不带 planner_profile 的最小请求仍然合法', () => {
    const result = TravelRequestUISchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('不带 planner_profile 时它是 undefined，而不是 19 个空子块', () => {
    /*
     * 用 optional 而不是 prefault({})：「客户端没发问卷」（P8 及之前的客户端）
     * 与「发了但全空」（V2 客户端上用户什么都没填）语义不同，下游要能区分。
     */
    const result = TravelRequestUISchema.parse(minimal);
    expect(result.planner_profile).toBeUndefined();
  });

  it('带 planner_profile 的请求解析后保留答案', () => {
    const result = TravelRequestUISchema.safeParse({
      ...minimal,
      planner_profile: {
        trip: { destinations: [{ text: '东京' }, { text: '京都' }], date_flexibility: 'PLUS_MINUS_3' },
        privacy: { trip_processing_consent: true, save_preferences: false },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.planner_profile?.trip?.destinations).toHaveLength(2);
    expect(result.data?.planner_profile?.privacy?.trip_processing_consent).toBe(true);
  });

  it('目的地上限 5 个（字段表：允许 1~5 个备选）', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `城市${i}` }));
    const result = TravelRequestUISchema.safeParse({
      ...minimal,
      planner_profile: { trip: { destinations: six } },
    });
    expect(result.success).toBe(false);
  });
});
