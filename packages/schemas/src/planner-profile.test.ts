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
        /* 首个目的地必须与 `trip.destination.text` 一致，见下面那组断言 */
        trip: {
          destinations: [{ text: '杭州' }, { text: '苏州' }],
          date_flexibility: 'PLUS_MINUS_3',
        },
        privacy: { trip_processing_consent: true, save_preferences: false },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.planner_profile?.trip?.destinations).toHaveLength(2);
    expect(result.data?.planner_profile?.privacy?.trip_processing_consent).toBe(true);
  });

  it('目的地上限 5 个（字段表：允许 1~5 个备选）', () => {
    /* 首个与 `trip.destination` 一致，因此这条只可能因为「超过 5 个」而失败 */
    const six = ['杭州', ...Array.from({ length: 5 }, (_, i) => `城市${i}`)].map((text) => ({
      text,
    }));
    const result = TravelRequestUISchema.safeParse({
      ...minimal,
      planner_profile: { trip: { destinations: six } },
    });
    expect(result.success).toBe(false);
  });
});

/**
 * 陷阱 3：`trip.destination` 是数据库提取列的来源，多城序列在
 * `planner_profile.trip.destinations` 里，两者必须一致。
 *
 * 静默取其一的两种走法都很糟：取前者让第 2～5 个城市凭空消失而计划看起来正常；
 * 取后者让数据库那一行的目的地与请求体不是同一个地方。
 */
describe('目的地两处一致（陷阱 3）', () => {
  const base = {
    schema_version: SCHEMA_VERSIONS.travelRequestUi,
    client_request_id: 'test-2',
    timezone: 'Asia/Shanghai',
    trip: {
      origin: { text: '上海' },
      destination: { text: '东京', place_id: 'tokyo' },
      dates: { start_date: '2026-09-01', end_date: '2026-09-03' },
    },
    travelers: { adults: 2 },
    budget: { basis: 'TOTAL', min: 8_000, max: 12_000 },
  } as const;

  it('首个目的地与 trip.destination 一致时通过', () => {
    const result = TravelRequestUISchema.safeParse({
      ...base,
      planner_profile: {
        trip: { destinations: [{ text: '东京', place_id: 'tokyo' }, { text: '京都' }] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('地点名不一致时被拒，且 path 指向具体那一处', () => {
    const result = TravelRequestUISchema.safeParse({
      ...base,
      planner_profile: { trip: { destinations: [{ text: '大阪' }] } },
    });
    expect(result.success).toBe(false);
    /* 13.7 要求请求校验错误带 field，而 field 就是从这个 path 来的 */
    expect(result.error?.issues[0]?.path).toEqual([
      'planner_profile',
      'trip',
      'destinations',
      0,
      'text',
    ]);
  });

  it('place_id 不一致时被拒', () => {
    const result = TravelRequestUISchema.safeParse({
      ...base,
      planner_profile: { trip: { destinations: [{ text: '东京', place_id: 'osaka' }] } },
    });
    expect(result.success).toBe(false);
  });

  it('只有一边有 place_id 时不算不一致 —— 还没接地点服务是受支持的中间态', () => {
    const result = TravelRequestUISchema.safeParse({
      ...base,
      planner_profile: { trip: { destinations: [{ text: '东京' }] } },
    });
    expect(result.success).toBe(true);
  });

  it('没有 planner_profile 或目的地为空时不参与比较', () => {
    /* P8 及之前的客户端一行不改仍然合法 —— 这条断言就是那句话的落点 */
    expect(TravelRequestUISchema.safeParse(base).success).toBe(true);
    expect(
      TravelRequestUISchema.safeParse({ ...base, planner_profile: { trip: { destinations: [] } } })
        .success,
    ).toBe(true);
  });
});

/**
 * 附录 C 的隐私检查项（阻塞发布）：**不采护照号、银行卡号、驾照号**。
 *
 * 这组断言扫的是 schema 本身而不是界面：界面上没有输入框只说明现在没在收，
 * 而契约里有那个字段就意味着**将来某个客户端可以发它**，且它会一路存进
 * `travel_requests.raw_request`。规范 20 的最小化原则要求的是后者不存在。
 */
describe('隐私最小化（附录 C 的阻塞发布项）', () => {
  /**
   * schema 的全部叶子路径。
   *
   * 复用本文件已有的 `objectShape`（它负责剥 `.optional()` 外壳）——
   * 在这里再写一份剥壳逻辑会让两份对 Zod 内部结构的假设各自演化，
   * 而其中一份跟不上 Zod 升级时，这组断言会静默扫到空集然后全部通过。
   */
  function leafPaths(schema: z.ZodTypeAny, prefix = ''): readonly string[] {
    const shape = objectShape(schema);
    if (shape === null) return prefix === '' ? [] : [prefix];
    return Object.entries(shape).flatMap(([key, value]) =>
      leafPaths(value, prefix === '' ? key : `${prefix}.${key}`),
    );
  }

  const paths = leafPaths(PlannerProfileSchema);

  it('抽路径本身有效 —— 否则下面的断言全部空转', () => {
    /*
     * 没有这一条的话，`objectShape` 哪天认不出 Zod 的结构会让 `paths` 变成
     * 空数组，而下面每一条「不该有 X」都会通过 —— 一组全绿但什么都没查的断言。
     */
    expect(paths.length).toBeGreaterThan(60);
    expect(paths).toContain('documents.passport_status.user_reported.status');
  });

  it('没有任何字段叫「号码」类的名字', () => {
    /*
     * 逐个禁词而不是一条大正则：红的时候要能一眼看出撞的是哪个词。
     * `reference`（订单号）不在禁词里 —— 字段表明确允许它且它是可选的，
     * 那是用户手上的凭证编号，不是支付凭据。
     */
    const forbidden = [
      'passport_number',
      'passport_no',
      'card_number',
      'card_no',
      'cvv',
      'license_number',
      'license_no',
      'id_number',
      'id_card',
      'account',
      'password',
      'membership_number',
    ];
    const offenders = paths.filter((path) =>
      forbidden.some((word) => path.toLowerCase().includes(word)),
    );
    expect(offenders).toEqual([]);
  });

  it('证件三块只收状态与日期', () => {
    /* 规范 20 与字段表：护照只要到期日与状态，签证只要状态与有效期 */
    expect(paths.filter((path) => path.startsWith('documents.')).sort()).toEqual([
      'documents.nationality_residency.nationality',
      'documents.nationality_residency.residency',
      'documents.passport_status.reported_on',
      'documents.passport_status.user_reported.expiry_date',
      'documents.passport_status.user_reported.status',
      'documents.visa_status.reported_on',
      'documents.visa_status.user_reported.status',
      'documents.visa_status.user_reported.valid_until',
    ]);
  });

  it('自驾只收核验条件，不收驾照号', () => {
    expect(paths.filter((path) => path.startsWith('transport.self_drive.')).sort()).toEqual([
      'transport.self_drive.reported_on',
      'transport.self_drive.user_reported.car_type',
      'transport.self_drive.user_reported.driver_age',
      'transport.self_drive.user_reported.experience',
      'transport.self_drive.user_reported.license_status',
    ]);
  });

  it('紧急联系人不收位置流水，只收一次授权选择', () => {
    /* 字段表：「位置共享独立授权」—— 授权是一个枚举，不是一串坐标 */
    expect(paths.filter((path) => path.startsWith('pretrip.emergency_contact.')).sort()).toEqual([
      'pretrip.emergency_contact.contact',
      'pretrip.emergency_contact.location_sharing',
      'pretrip.emergency_contact.name',
      'pretrip.emergency_contact.relation',
    ]);
  });
});
