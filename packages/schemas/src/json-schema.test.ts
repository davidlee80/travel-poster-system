import { describe, expect, it } from 'vitest';

import {
  STRICT_FORBIDDEN_KEYWORDS,
  normalizeStrictLlmOutput,
  travelPlanLlmOutputJsonSchema,
  travelPlanLlmOutputStrictJsonSchema,
} from './json-schema.js';
import { TravelPlanLlmOutputSchema } from './travel-plan.js';
import { makeTravelPlanFixture } from './fixtures.js';

/**
 * strict 兼容 schema（接 ofox / OpenAI 结构化输出用）。
 *
 * 断言集中在三处「错了不会有别的东西发现」的地方：
 *   1. 三条 strict 规则真的全部满足 —— 违反其中任一条是端点直接 400，
 *      而生产日志里只有 `PLAN_LLM_UNAVAILABLE: HTTP 400`；
 *   2. 可选属性变成**可空必填**而不是被强制必填 —— 后者会让模型把
 *      「没有城际交通」填成 0，把「未知」和「零」合并；
 *   3. 归一后的输出仍能通过 Zod —— 这是整条链真正的验收点。
 */

const FORBIDDEN = new Set(STRICT_FORBIDDEN_KEYWORDS);

/** 递归收集违规点，与 tools/probe-llm.mjs 的体检同一套判据 */
function audit(
  node: unknown,
  at = '',
): { missingAP: string[]; optional: string[]; banned: string[] } {
  const report = { missingAP: [] as string[], optional: [] as string[], banned: [] as string[] };

  const walk = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    const obj = current as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
      if (FORBIDDEN.has(key)) report.banned.push(`${path || '(root)'}.${key}`);
    }

    if (obj['type'] === 'object' || obj['properties'] !== undefined) {
      if (obj['additionalProperties'] !== false) report.missingAP.push(path || '(root)');
      const required = new Set((obj['required'] as string[] | undefined) ?? []);
      const properties = (obj['properties'] as Record<string, unknown> | undefined) ?? {};
      for (const name of Object.keys(properties)) {
        if (!required.has(name)) report.optional.push(`${path || '(root)'}.${name}`);
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      walk(value, path === '' ? key : `${path}.${key}`);
    }
  };

  walk(node, at);
  return report;
}

describe('strict 兼容 schema', () => {
  it('原样 schema 违反 strict 规则 —— 这是净化存在的前提', () => {
    /*
     * 这条断言的作用是「前提失效时立刻知道」：如果哪天 Zod 的导出变了、
     * 或者 schema 定义不再用 .min()/.regex()，原样那份就已经合规，
     * 净化的取舍（丢掉格式与范围约束）就不必再付了。
     */
    const report = audit(travelPlanLlmOutputJsonSchema);

    expect(report.missingAP.length).toBeGreaterThan(0);
    expect(report.banned.length).toBeGreaterThan(0);
  });

  it('满足 strict 的三条规则', () => {
    const report = audit(travelPlanLlmOutputStrictJsonSchema);

    // 规则 1：每个 object 显式禁止额外属性
    expect(report.missingAP).toEqual([]);
    // 规则 2：没有可选属性
    expect(report.optional).toEqual([]);
    // 规则 3：一个禁用关键字都不剩
    expect(report.banned).toEqual([]);
  });

  it('可选属性变成可空必填，而不是被强制必填', () => {
    /*
     * `total_budget` 的两个金额是 `total` 的子集，`undefined` 的语义是
     * 「模型没给 → 不扣除 + 记一条 assumption」（见 travel-plan.ts）。
     * 强制必填会逼模型在「确实没有城际交通」时填 0 —— 而 0 与「没有」
     * 在 V-20/V-21 那里不是一回事。
     */
    const budget = (
      travelPlanLlmOutputStrictJsonSchema['properties'] as Record<string, Record<string, unknown>>
    )['total_budget'];
    const properties = budget?.['properties'] as Record<string, Record<string, unknown>>;

    expect(properties['intercity_transport']?.['type']).toEqual(['number', 'null']);
    expect(properties['shopping']?.['type']).toEqual(['number', 'null']);
    // 必填，但可以是 null —— 两件事同时成立才是 strict 的正确形态
    expect(budget?.['required']).toContain('intercity_transport');
    expect(budget?.['required']).toContain('shopping');

    // 本来必填的字段不受影响
    expect(properties['total']?.['type']).toBe('number');
  });

  it('不改动原样 schema（两份要能同时用于对照）', () => {
    // 净化是纯函数式的；就地改会让 probe-llm.mjs 的 S1/S2 对照变成同一份
    const raw = travelPlanLlmOutputJsonSchema as Record<string, unknown>;
    expect(raw['additionalProperties']).toBeUndefined();
  });
});

describe('normalizeStrictLlmOutput', () => {
  it('把可空字段的 null 还原成「没给」，Zod 随后仍能通过', () => {
    const fixture = makeTravelPlanFixture({ totalDays: 2 });
    const output = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
    // 模型在 strict 模式下用 null 表达「没有这一项」
    (output['total_budget'] as Record<string, unknown>)['intercity_transport'] = null;
    (output['total_budget'] as Record<string, unknown>)['shopping'] = null;

    const normalized = normalizeStrictLlmOutput(output) as Record<string, unknown>;
    const budget = normalized['total_budget'] as Record<string, unknown>;

    // 删键而不是留 undefined：Zod 的 .optional() 对两者都放行，
    // 但留下 null 会直接报 expected number
    expect('intercity_transport' in budget).toBe(false);
    expect('shopping' in budget).toBe(false);
    expect(TravelPlanLlmOutputSchema.safeParse(normalized).success).toBe(true);
  });

  it('有实际数值时原样保留', () => {
    const fixture = makeTravelPlanFixture({ totalDays: 1 });
    const output = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
    (output['total_budget'] as Record<string, unknown>)['intercity_transport'] = 480;

    const budget = (normalizeStrictLlmOutput(output) as Record<string, unknown>)[
      'total_budget'
    ] as Record<string, unknown>;

    expect(budget['intercity_transport']).toBe(480);
  });

  it('只碰被改成可空的那几个键，不递归删所有 null', () => {
    /*
     * 「递归删掉所有 null」会把将来真的以 null 为合法值的字段一起吞掉，
     * 而那种缺陷表现为「字段莫名消失」，极难查。
     */
    const input = { title: null, total_budget: { intercity_transport: null } };

    const out = normalizeStrictLlmOutput(input) as Record<string, unknown>;

    expect('title' in out).toBe(true);
    expect(out['title']).toBeNull();
    expect('intercity_transport' in (out['total_budget'] as Record<string, unknown>)).toBe(false);
  });

  it('结构不符时原样返回，不抛错', () => {
    // 模型输出千奇百怪，归一不该是新的失败点 —— 形状问题交给 Zod 报
    expect(normalizeStrictLlmOutput(null)).toBeNull();
    expect(normalizeStrictLlmOutput('文本')).toBe('文本');
    expect(normalizeStrictLlmOutput({ total_budget: 42 })).toEqual({ total_budget: 42 });
  });
});
