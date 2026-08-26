import { describe, expect, it } from 'vitest';

import {
  PLANNER_CONSTRAINT_PRECEDENCE,
  PLANNER_CONSTRAINT_TYPE_VALUES,
  PLANNER_FIELDS,
  PLANNER_FIELD_COUNT,
  PLANNER_RUNTIME_TYPE_META,
  PLANNER_RUNTIME_TYPE_VALUES,
  PLANNER_STEPS,
  PLANNER_STEP_IDS,
  constraintTypeOf,
  plannerField,
  plannerFieldsOfStep,
  type PlannerFieldId,
  type PlannerRuntimeType,
  type PlannerStepId,
  type PlannerSummaryGroup,
} from './planner-fields.js';

/**
 * 这一整个文件守的是规范 21.1 与附录 C 的**阻塞发布**级门槛：
 * 「76 个产品字段 = 76 个唯一 Field ID + 76 个独立 API binding；复合 UI 不合并字段」。
 *
 * 逐项断言而不是只数一个 76：数量对而内容错（某个字段被抄成另一个字段的
 * API Key）在界面上完全看不出来 —— 两个字段共用一个 binding 时，
 * 后写的那个会静默覆盖前一个的值。
 */

describe('Planner 字段元数据（规范 21.1 硬门槛）', () => {
  it('字段总数与冻结常量一致', () => {
    expect(PLANNER_FIELDS).toHaveLength(PLANNER_FIELD_COUNT);
  });

  it('field_id 唯一', () => {
    const ids = PLANNER_FIELDS.map((field) => field.field_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('api_key 唯一 —— 复合视觉控件不允许合并 binding', () => {
    const keys = PLANNER_FIELDS.map((field) => field.api_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('field_id 形如 PV2-<步骤>-<序号>，且步骤段与 step 列一致', () => {
    for (const field of PLANNER_FIELDS) {
      expect(field.field_id, `${field.field_id} 格式不对`).toMatch(/^PV2-\d{2}-\d{3}$/);
      expect(field.field_id.slice(4, 6), `${field.field_id} 的步骤段与 step 列不一致`).toBe(
        field.step,
      );
    }
  });

  it('步内序号从 001 连续递增无缺号', () => {
    const seen = new Map<PlannerStepId, number>();
    for (const field of PLANNER_FIELDS) {
      const ordinal = Number(field.field_id.slice(7));
      const previous = seen.get(field.step);
      expect(ordinal, `${field.field_id} 与前一个字段不连续`).toBe(
        previous === undefined ? 1 : previous + 1,
      );
      seen.set(field.step, ordinal);
    }
  });

  it('api_key 形如 <块>.<字段>，两段且小写', () => {
    for (const field of PLANNER_FIELDS) {
      expect(field.api_key, `${field.field_id} 的 api_key 不是两段式小写`).toMatch(
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
      );
    }
  });

  /**
   * 规范 2.2 的字段分布表。照抄而不是从数组算 —— 从数组算的话「漏抄一个字段」
   * 与「表本来就是 8 个」无法区分，而这条断言的全部意义就是区分它们。
   */
  it('每步字段数与规范 2.2 的分布表一致', () => {
    const expected: Record<PlannerStepId, number> = {
      '01': 9,
      '02': 6,
      '03': 6,
      '04': 8,
      '05': 7,
      '06': 8,
      '07': 10,
      '08': 10,
      '09': 6,
      '10': 6,
    };
    for (const step of PLANNER_STEP_IDS) {
      expect(plannerFieldsOfStep(step), `第 ${step} 步字段数不对`).toHaveLength(expected[step]);
    }
    // 分布表之和必须等于总数，否则上面十条全过也可能漏了整整一步
    const sum = Object.values(expected).reduce((a, b) => a + b, 0);
    expect(sum).toBe(PLANNER_FIELD_COUNT);
  });

  it('字段层级分布与字段表一致（主流程 51 / 条件触发 19 / 方案后补充 6）', () => {
    const count = (level: string) => PLANNER_FIELDS.filter((f) => f.level === level).length;
    expect(count('MAIN')).toBe(51);
    expect(count('CONDITIONAL')).toBe(19);
    expect(count('POST_PLAN')).toBe(6);
  });

  it('优先级分布与规范 23 章的交付边界一致（P0 52 / P1 20 / P2 4）', () => {
    const count = (priority: string) =>
      PLANNER_FIELDS.filter((f) => f.priority === priority).length;
    expect(count('P0')).toBe(52);
    expect(count('P1')).toBe(20);
    expect(count('P2')).toBe(4);
  });

  /**
   * 规范 21.1 点名要求的一条：「PV2-02-002 travelers.profiles 必须独立存在」。
   *
   * 它被点名是因为同行人数与旅行者档案在界面上是同一个区块，最容易被合并成
   * 「PV2-02-001/002」—— 而规范 3.3 明确禁止这种合并标识。
   */
  it('PV2-02-002 travelers.profiles 独立存在，且与 PV2-02-001 不同 binding', () => {
    const profiles = plannerField('PV2-02-002');
    const count = plannerField('PV2-02-001');
    expect(profiles.api_key).toBe('travelers.profiles');
    expect(count.api_key).toBe('travelers.count');
    expect(profiles.api_key).not.toBe(count.api_key);
  });

  it('条件触发层级的字段不会是「始终显示」', () => {
    for (const field of PLANNER_FIELDS.filter((f) => f.level === 'CONDITIONAL')) {
      expect(field.trigger, `${field.field_id} 是条件触发字段却始终显示`).not.toBe('始终显示');
    }
  });

  it('方案后补充的字段全部落在第 10 步且不阻塞', () => {
    for (const field of PLANNER_FIELDS.filter((f) => f.level === 'POST_PLAN')) {
      expect(field.step, `${field.field_id} 不在第 10 步`).toBe('10');
      expect(field.blocking, `${field.field_id} 不应阻塞初步方案`).toBe('NEVER');
    }
    // 反向：第 10 步只有方案后补充字段
    for (const field of plannerFieldsOfStep('10')) {
      expect(field.level, `${field.field_id} 在第 10 步却不是方案后补充`).toBe('POST_PLAN');
    }
  });

  /**
   * 摘要分组通常由运行时类型决定，但字段表有**四条刻意的例外**。
   *
   * 把例外写成白名单而不是放弃这条断言：例外全都有产品理由（过敏与健康入口
   * 是 FACT，但它们要出现在「还需要确认」里促成后续追问；旅行目的是 FACT，
   * 但它表达的是取向因此进「优先满足」），而没理由的第五条例外就是抄错了。
   */
  it('摘要分组与运行时类型的偏离恰好是字段表里那四条', () => {
    const deviations = PLANNER_FIELDS.filter(
      (field) =>
        field.summary_group !== PLANNER_RUNTIME_TYPE_META[field.runtime_type].summary_group,
    ).map((field) => `${field.field_id}:${field.runtime_type}→${field.summary_group}`);

    expect(deviations).toEqual([
      'PV2-01-006:FACT→PREFER',
      'PV2-07-003:FACT→VERIFY',
      'PV2-07-009:PREFER_EXCLUDE→EXCLUDE',
      'PV2-08-001:FACT→VERIFY',
    ]);
  });

  it('高度敏感字段不进入除「还需要确认」与「不展示」以外的摘要组', () => {
    /*
     * 规范 20：「高度敏感字段不在右侧显示具体值，只显示安全需求抽象状态」。
     * 允许 MUST —— 无障碍需求与过敏详情确实是必须满足的硬约束，它们要出现在
     * 那一组里，只是显示的是抽象摘要而不是具体值（脱敏由 summary.ts 负责）。
     */
    const allowed: readonly PlannerSummaryGroup[] = ['MUST', 'VERIFY', 'HIDDEN', 'SKELETON'];
    for (const field of PLANNER_FIELDS.filter((f) => f.sensitivity === 'HIGH')) {
      expect(allowed, `${field.field_id} 的摘要组对高度敏感字段不合适`).toContain(
        field.summary_group,
      );
    }
  });
});

describe('运行时类型与约束优先级（规范 4 章）', () => {
  it('每个运行时类型都有语义元数据且文案非空', () => {
    for (const runtime of PLANNER_RUNTIME_TYPE_VALUES) {
      const meta = PLANNER_RUNTIME_TYPE_META[runtime];
      expect(meta.label.length, `${runtime} 缺 label`).toBeGreaterThan(0);
      expect(meta.semantic.length, `${runtime} 缺 semantic`).toBeGreaterThan(0);
      expect(meta.aria.length, `${runtime} 缺 aria`).toBeGreaterThan(0);
    }
  });

  it('优先级权重两两不等 —— 相等意味着冲突处理无法定序', () => {
    const weights = Object.values(PLANNER_CONSTRAINT_PRECEDENCE);
    expect(new Set(weights).size).toBe(weights.length);
  });

  it('优先级顺序就是 4.1 的 LOCKED > CONSENT > HARD > EXCLUDE > VERIFY > PREFER', () => {
    const p = PLANNER_CONSTRAINT_PRECEDENCE;
    expect(p.LOCKED).toBeLessThan(p.CONSENT);
    expect(p.CONSENT).toBeLessThan(p.HARD);
    expect(p.HARD).toBeLessThan(p.EXCLUDE);
    expect(p.EXCLUDE).toBeLessThan(p.VERIFY_BLOCKING);
    expect(p.VERIFY_BLOCKING).toBeLessThan(p.VERIFY_NONBLOCKING);
    expect(p.VERIFY_NONBLOCKING).toBeLessThan(p.PREFER);
  });

  it('constraintTypeOf：只有 PREFER_EXCLUDE 无法一对一映射', () => {
    for (const runtime of PLANNER_RUNTIME_TYPE_VALUES) {
      const mapped = constraintTypeOf(runtime);
      if (runtime === 'PREFER_EXCLUDE') {
        expect(mapped).toBeNull();
        continue;
      }
      expect(mapped, `${runtime} 没有对应的运行时约束类型`).not.toBeNull();
      expect(PLANNER_CONSTRAINT_TYPE_VALUES).toContain(mapped);
    }
  });

  it('LOCKED 是运行时约束类型，但不是任何字段的静态类型', () => {
    /*
     * 规范 4 章的注：LOCKED 由 trip.locked_order_types / trip.locked_orders
     * 的有效记录派生。附录 A 里 PV2-01-009 是 HARD —— 这不是笔误。
     */
    expect(PLANNER_CONSTRAINT_TYPE_VALUES).toContain('LOCKED');
    expect(PLANNER_RUNTIME_TYPE_VALUES as readonly string[]).not.toContain('LOCKED');
    expect(plannerField('PV2-01-009').runtime_type).toBe('HARD');
  });
});

describe('三级命名体系（规范 2.1）', () => {
  it('覆盖 10 个步骤且顺序一致', () => {
    expect(PLANNER_STEPS.map((step) => step.step)).toEqual([...PLANNER_STEP_IDS]);
  });

  it('三个名字各自唯一且非空 —— 合并任意两个都会让文案迭代改掉埋点分组键', () => {
    const navs = PLANNER_STEPS.map((s) => s.nav);
    const titles = PLANNER_STEPS.map((s) => s.title);
    const modules = PLANNER_STEPS.map((s) => s.module);
    expect(new Set(navs).size).toBe(navs.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(modules).size).toBe(modules.length);
    for (const step of PLANNER_STEPS) {
      expect(step.nav.length, `第 ${step.step} 步缺导航名`).toBeGreaterThan(0);
      expect(step.title.length, `第 ${step.step} 步缺页面标题`).toBeGreaterThan(0);
      expect(step.module.length, `第 ${step.step} 步缺内部模块名`).toBeGreaterThan(0);
      expect(step.intro.length, `第 ${step.step} 步缺一句话解释`).toBeGreaterThan(0);
    }
  });
});

describe('查询函数', () => {
  it('plannerField 取到对应元数据', () => {
    expect(plannerField('PV2-07-004').api_key).toBe('food.allergy_details');
    expect(plannerField('PV2-07-004').runtime_type).toBe('HARD');
    expect(plannerField('PV2-07-004').sensitivity).toBe('HIGH');
  });

  it('plannerField 遇到表外 ID 直接抛 —— 静默 undefined 会让摘要 chip 点了不跳转', () => {
    // 断言运行期行为，因此要绕过编译期的字面量联合
    const unknown = 'PV2-99-999' as PlannerFieldId;
    expect(() => plannerField(unknown)).toThrow('未知的 Planner 字段 ID：PV2-99-999');
  });

  it('plannerFieldsOfStep 保持全表内的相对顺序（= 页面区块顺序）', () => {
    const fromTable = PLANNER_FIELDS.filter((f) => f.step === '07').map((f) => f.field_id);
    expect(plannerFieldsOfStep('07').map((f) => f.field_id)).toEqual(fromTable);
  });

  it('全部字段的 runtime_type 都在枚举内', () => {
    const values: readonly PlannerRuntimeType[] = PLANNER_RUNTIME_TYPE_VALUES;
    for (const field of PLANNER_FIELDS) {
      expect(values, `${field.field_id} 的 runtime_type 越界`).toContain(field.runtime_type);
    }
  });
});
