import {
  FORBIDDEN_PROJECTION_KEYS,
  RetrievalProjectionSchema,
  findForbiddenProjectionKeys,
  type TravelPlan,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { makeValidPlan } from './plan-fixtures.js';
import {
  buildRetrievalProjection,
  parseRetrievalProjection,
  projectionToEmbeddingText,
} from './retrieval-projection.js';

/**
 * 脱敏投影（TP-2-20，设计稿 3.2.4）。
 *
 * 验收要求是「**逐字段单测**：对 3.2.4 表格每一行断言『该进』或『该剔』」。
 * 下面两张表就是那张表格的机器化形式 —— 设计稿改一行，这里改一行，
 * 两边对不上就是测试失败。
 *
 * 这是 RISK-14（脱敏投影漏字段，敏感数据流入他人生成上下文）的第一道防护，
 * 也是唯一一道能在**写入前**发现问题的防护：后三道（向量由投影计算、
 * 仓储返回类型、列级 GRANT）都只能阻止读出去，阻止不了写进去。
 */

const plan = makeValidPlan();
const projection = buildRetrievalProjection(plan);
const serialized = JSON.stringify(projection);

/** 3.2.4 表格里标「是」的行 */
const INCLUDED: readonly (readonly [string, () => unknown])[] = [
  ['destination.name', () => projection.destination.name],
  ['destination.place_id', () => projection.destination.place_id],
  ['total_days', () => projection.total_days],
  ['days[].theme', () => projection.days[0]?.theme],
  ['days[].subtitle', () => projection.days[0]?.subtitle],
  ['days[].schedule[].title', () => projection.days[0]?.schedule[0]?.title],
  ['days[].schedule[].location.name', () => projection.days[0]?.schedule[0]?.location.name],
  ['days[].schedule[].location.place_id', () => projection.days[0]?.schedule[0]?.location.place_id],
  ['days[].schedule[].period', () => projection.days[0]?.schedule[0]?.period],
  ['days[].schedule[].duration_minutes', () => projection.days[0]?.schedule[0]?.duration_minutes],
  ['days[].schedule[].description', () => projection.days[0]?.schedule[0]?.description],
  ['days[].food_recommendations[].name', () => projection.days[0]?.food_recommendations[0]?.name],
  [
    'days[].food_recommendations[].entity_type',
    () => projection.days[0]?.food_recommendations[0]?.entity_type,
  ],
  [
    'days[].route_recommendations[].nodes',
    () => projection.days[0]?.route_recommendations[0]?.nodes,
  ],
];

/**
 * 3.2.4 表格里标「否」的行 —— 用**值**断言而不是键名。
 *
 * 只查键名不够：投影里没有 `estimated_cost` 这个键，但如果金额被拼进了
 * `description`，隐私一样泄漏了。因此对每一行取计划里的真实值，
 * 断言它不出现在投影的序列化结果里。
 */
const EXCLUDED: readonly (readonly [string, string])[] = [
  ['start_date', plan.start_date],
  ['end_date', plan.end_date],
  ['days[].date', plan.days[0]!.date],
  ['total_budget.total', String(plan.total_budget.total)],
  ['total_budget.per_person', String(plan.total_budget.per_person)],
  ['daily_budget.total', String(plan.days[0]!.daily_budget.total)],
  ['plan_id', plan.plan_id],
  ['plan_version_id', plan.plan_version_id],
  ['request_id', plan.request_id],
];

describe('3.2.4 逐字段：该进的字段', () => {
  it.each(INCLUDED)('%s 在投影中', (_name, read) => {
    const value = read();
    expect(value).toBeDefined();
    expect(value).not.toBeNull();
  });

  it('POI 序列保持原顺序', () => {
    // 3.2.4：「POI 序列是核心可复用知识」—— 顺序本身就是知识
    expect(projection.days[0]!.schedule.map((item) => item.location.name)).toEqual(
      plan.days[0]!.schedule.map((item) => item.location.name),
    );
  });

  it('天数与各天数量与原计划一致', () => {
    expect(projection.total_days).toBe(plan.total_days);
    expect(projection.days).toHaveLength(plan.days.length);
  });

  it('产物满足 RetrievalProjectionSchema', () => {
    expect(RetrievalProjectionSchema.safeParse(projection).success).toBe(true);
  });
});

describe('3.2.4 逐字段：该剔的字段', () => {
  it.each(EXCLUDED)('%s 的值不出现在投影里', (_name, value) => {
    expect(value.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(value);
  });

  it('没有任何禁止键名', () => {
    expect(findForbiddenProjectionKeys(projection)).toEqual([]);
  });

  it('禁止键清单覆盖 3.2.4 的全部「否」行', () => {
    for (const key of [
      'start_date',
      'end_date',
      'date',
      'total_budget',
      'daily_budget',
      'estimated_cost',
      'traveler_count',
      'children',
      'seniors',
      'raw_text',
      'constraint_report',
      'user_id',
      'plan_id',
      'request_id',
    ]) {
      expect(FORBIDDEN_PROJECTION_KEYS, `${key} 未登记为禁止键`).toContain(key);
    }
  });

  it('检测函数真的能发现漏网字段', () => {
    /*
     * 反向验证扫描器本身。若 findForbiddenProjectionKeys 因为写错而永远返回
     * 空数组，上面「没有任何禁止键名」会永远通过 —— 一个什么都不检查的检查。
     */
    const polluted = { ...projection, days: [{ ...projection.days[0]!, date: '2026-04-10' }] };
    expect(findForbiddenProjectionKeys(polluted)).toEqual(['days[0].date']);
  });

  it('计划新增字段不会自动流入投影', () => {
    /*
     * 白名单方向的核心断言。用减法写法（clone 后 delete）时这条会失败 ——
     * 而它对应的真实场景是：某次给 TravelPlan 加了一个带用户信息的字段，
     * 没人想到它会跟着投影跨用户流出去。
     */
    const withExtra = {
      ...makeValidPlan(),
      internal_note: '用户电话 13800000000',
    } as TravelPlan & Record<string, unknown>;

    expect(JSON.stringify(buildRetrievalProjection(withExtra))).not.toContain('13800000000');
  });
});

describe('向量化文本（TP-2-21）', () => {
  it('同一投影产出同一段文本', () => {
    // 向量必须可复现，否则同一份计划两次写入会得到两个不同的向量，
    // 而「为什么召回结果变了」将无从排查
    expect(projectionToEmbeddingText(projection)).toBe(projectionToEmbeddingText(projection));
  });

  it('文本包含 POI 与主题，不含金额与日期', () => {
    const text = projectionToEmbeddingText(projection);
    expect(text).toContain('拱宸桥');
    expect(text).toContain(plan.days[0]!.theme);
    expect(text).not.toContain(plan.start_date);
    expect(text).not.toContain(String(plan.total_budget.total));
  });

  it('敏感值只存在于 plan_json 时不影响向量文本', () => {
    /*
     * TP-2-21 的反向测试。把敏感语义塞进**不进投影**的字段，
     * 断言向量化文本一字不差 —— 也就是说这些语义不可能以向量形式残留。
     */
    const clean = makeValidPlan();
    const polluted = makeValidPlan();
    polluted.summary = '预算 30000 元，同行有 2 名儿童，联系电话 13800000000';
    polluted.constraint_report.assumptions.push({
      code: 'X',
      text: '用户要求无障碍房间（轮椅）',
      rule_id: null,
    });
    polluted.total_budget.total = 999_999;
    polluted.days[0]!.daily_summary = '今天花了 5000 元';

    expect(projectionToEmbeddingText(buildRetrievalProjection(polluted))).toBe(
      projectionToEmbeddingText(buildRetrievalProjection(clean)),
    );
  });
});

describe('读取历史投影', () => {
  it('形状合法时解析成功', () => {
    expect(parseRetrievalProjection(JSON.parse(serialized))).not.toBeNull();
  });

  it('旧版本或形状不符时返回 null 而不是抛错', () => {
    /*
     * 库里可能有投影规则修订之前写入的行。跨用户读取时把它当「这条参考
     * 不可用」跳过，而不是把形状未知的 JSON 塞进 LLM 上下文 ——
     * 那份 JSON 里可能正好带着旧规则漏掉的敏感字段。
     */
    expect(parseRetrievalProjection({ schema_version: 'retrieval_projection_v0' })).toBeNull();
    expect(parseRetrievalProjection(null)).toBeNull();
    expect(parseRetrievalProjection({ ...projection, days: 'oops' })).toBeNull();
  });
});
