import {
  buildRetrievalProjection,
  makeValidContext,
  makeValidPlan,
  planCities,
} from '@tps/planning';
import { makeTravelPlanFixture, type TravelPlanLlmOutput } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  MAX_DAYS_PER_SEGMENT,
  MAX_TOKENS_TIERS,
  PLAN_SYSTEM_PROMPT,
  buildPlanPrompt,
  buildRepairPrompt,
  maxTokensForDays,
  mergeSegments,
  planSegments,
} from './prompt.js';

/**
 * 提示与分段（TP-2-11，设计稿 6.3）。
 *
 * 6.3 的五条约束里有四条只能在这里验证（第五条 `response_format`
 * 在 client.test.ts）。它们的共同特点是**违反后不会报错**：
 * token 档位给小了表现为「第 9 天之后没有内容」，
 * 分段边界算错表现为「天数比请求多一天」，
 * 忘了要求不生成 ID 表现为模型编出一个 UUID 而程序信了它。
 */

const normalized = makeValidContext().normalized;
const plan = makeValidPlan();
const llmOutput: TravelPlanLlmOutput = (() => {
  const {
    schema_version: _s,
    status: _t,
    plan_id: _p,
    plan_version_id: _v,
    request_id: _r,
    ...content
  } = plan;
  return content;
})();

describe('6.3 token 分档', () => {
  it.each([
    [1, 16_384],
    [5, 16_384],
    [6, 32_768],
    [10, 32_768],
    [11, 49_152],
    [14, 49_152],
  ])('%i 天 → %i tokens', (days, expected) => {
    expect(maxTokensForDays(days)).toBe(expected);
  });

  it('分档表与设计稿一致', () => {
    expect(MAX_TOKENS_TIERS.map((tier) => [tier.maxDays, tier.maxTokens])).toEqual([
      [5, 16_384],
      [10, 32_768],
      [14, 49_152],
    ]);
  });

  it('超过 14 天用最高档兜底而不是抛错', () => {
    // N-03 已经拦住 >14 天；真走到这里说明校验被绕过，
    // 此时「可能被截断的计划」仍好过「任务直接崩」
    expect(maxTokensForDays(30)).toBe(49_152);
  });
});

describe('6.3 分段生成', () => {
  it.each([
    [1, [[1, 1]]],
    [7, [[1, 7]]],
    [
      8,
      [
        [1, 7],
        [8, 8],
      ],
    ],
    [
      14,
      [
        [1, 7],
        [8, 14],
      ],
    ],
  ])('%i 天切成 %j', (totalDays, expected) => {
    expect(planSegments(totalDays).map((s) => [s.startDay, s.endDay])).toEqual(expected);
  });

  it('每段都不超过 7 天', () => {
    for (let days = 1; days <= 14; days += 1) {
      for (const segment of planSegments(days)) {
        expect(segment.endDay - segment.startDay + 1).toBeLessThanOrEqual(MAX_DAYS_PER_SEGMENT);
      }
    }
  });

  it('分段连续、无重叠、不留空段', () => {
    /*
     * 空段会让某次调用要求模型「生成 0 天的行程」，而模型通常会自己补一天
     * —— 合并后天数比请求多，V-01 报 BLOCKING。
     */
    for (let days = 1; days <= 14; days += 1) {
      const segments = planSegments(days);
      expect(segments[0]!.startDay).toBe(1);
      expect(segments.at(-1)!.endDay).toBe(days);
      for (const segment of segments) {
        expect(segment.endDay).toBeGreaterThanOrEqual(segment.startDay);
      }
      for (let i = 1; i < segments.length; i += 1) {
        expect(segments[i]!.startDay).toBe(segments[i - 1]!.endDay + 1);
      }
    }
  });
});

describe('系统提示：格式与禁令', () => {
  it('明确要求不生成任何标识符（6.3）', () => {
    // 忘了这条的表现是模型编出一个 UUID，而程序若信了它就会污染归属关系
    expect(PLAN_SYSTEM_PROMPT).toContain('plan_id');
    expect(PLAN_SYSTEM_PROMPT).toContain('由程序填写');
  });

  it('明确禁止 URL、HTML 与 Markdown', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('http://');
    expect(PLAN_SYSTEM_PROMPT).toContain('HTML');
    expect(PLAN_SYSTEM_PROMPT).toContain('Markdown');
  });

  it('要求标注 child_friendly（R-20）', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('child_friendly');
  });

  it('要求单个 JSON 对象且不带代码块标记', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象');
    expect(PLAN_SYSTEM_PROMPT).toContain('代码块');
  });
});

describe('生成提示', () => {
  const single = { normalized, segment: { startDay: 1, endDay: 5 }, totalSegments: 1 };

  it('包含目的地、天数、人数、预算与节奏', () => {
    const { user } = buildPlanPrompt({ ...single, references: [] });
    expect(user).toContain('杭州');
    expect(user).toContain('共 5 天');
    expect(user).toContain('3 人');
    expect(user).toContain('每日 2～3 个景点');
  });

  it('硬约束与软约束分开列出', () => {
    // 混在一起会让模型无法区分「不可违反」与「尽量满足」，
    // 而 V-30 只校验前者
    const { user } = buildPlanPrompt({ ...single, references: [] });
    expect(user).toContain('必须满足的条件：accommodation.elevator');
    expect(user).toContain('尽量满足的条件：interest.history_culture');
  });

  it('无历史参考时明确说明', () => {
    const { user } = buildPlanPrompt({ ...single, references: [] });
    expect(user).toContain('历史参考：无');
  });

  it('有参考时只给行程结构，不含金额与日期', () => {
    /*
     * 参考来自**别人的**计划。投影已经剔掉了敏感字段（3.2.4），
     * 这里再断言一次是因为提示词是数据流的最后一站 ——
     * 它之后就直接出网了。
     */
    /*
     * 参考计划刻意用与本次请求**不同**的日期：两者相同的话，
     * 「提示里没有参考的日期」与「提示里有本次请求的日期」无法区分 ——
     * 而本次请求的日期本来就该在提示里（那是用户自己的数据）。
     */
    const other = makeTravelPlanFixture({ totalDays: 5, startDate: '2025-11-03' });
    const { user } = buildPlanPrompt({ ...single, references: [buildRetrievalProjection(other)] });

    expect(user).toContain('历史参考');
    expect(user).toContain('拱宸桥');
    expect(user).not.toContain('2025-11-03');
    expect(user).not.toContain(String(other.total_budget.total));
    expect(user).not.toContain(String(other.days[0]!.daily_budget.total));
  });

  it('单段时要求生成全程', () => {
    const { user } = buildPlanPrompt({ ...single, references: [] });
    expect(user).toContain('第 1 天到第 5 天的完整行程');
  });

  it('多段时只要求本段，并说明整体天数', () => {
    const { user } = buildPlanPrompt({
      normalized: makeValidContext({
        trip: {
          origin: { text: '上海', place_id: 'cn-shanghai' },
          destination: {
            mode: 'FIXED',
            text: '杭州',
            place_id: 'cn-hangzhou',
            allow_multiple_destinations: false,
          },
          dates: { start_date: '2026-04-10', end_date: '2026-04-23', flexibility_days: 0 },
        },
      }).normalized,
      segment: { startDay: 8, endDay: 14 },
      totalSegments: 2,
      references: [],
    });

    expect(user).toContain('第 8 天到第 14 天');
    expect(user).toContain('整趟共 14 天');
    expect(user).toContain('days 数组只包含这几天');
  });

  it('给出日期与城市的填写规则', () => {
    // V-03 与 V-04 会强制覆写，但让模型一开始就写对能省一轮修复
    const { user } = buildPlanPrompt({ ...single, references: [] });
    expect(user).toContain('2026-04-10 加 N-1 天');
    expect(user).toContain('city 一律填「杭州」');
  });
});

describe('修复提示（3.2.2 第二级）', () => {
  it('带上违规清单与上一版内容', () => {
    /*
     * 只重发原始需求得到的是另一份随机结果，同样的问题很可能再犯 ——
     * 「你上次这样写，这几条不合规」才是「定向」重生成。
     */
    const { user } = buildRepairPrompt({
      normalized,
      violations: [{ rule: 'V-05', path: 'days[2].schedule', detail: '当日没有任何行程条目' }],
      previous: llmOutput,
      attempt: 1,
    });

    expect(user).toContain('第 1 次修正请求');
    expect(user).toContain('[V-05] days[2].schedule');
    expect(user).toContain('当日没有任何行程条目');
    expect(user).toContain('拱宸桥');
  });

  it('重申硬约束并要求写进 satisfied', () => {
    // V-30 校验的是 satisfied 列表；不重申的话模型改完行程仍然不写报告
    const { user } = buildRepairPrompt({
      normalized,
      violations: [{ rule: 'V-30', path: 'constraint_report.satisfied', detail: '硬约束未满足' }],
      previous: llmOutput,
      attempt: 2,
    });
    expect(user).toContain('accommodation.elevator');
    expect(user).toContain('satisfied');
  });

  it('与生成提示共用同一份系统提示', () => {
    // 格式禁令对两条路径同样有效；各写一份必然出现「修复输出带了 Markdown」
    expect(
      buildRepairPrompt({
        normalized,
        violations: [],
        previous: llmOutput,
        attempt: 1,
      }).system,
    ).toBe(PLAN_SYSTEM_PROMPT);
  });
});

describe('分段合并（6.3）', () => {
  function segment(days: number, offset: number): TravelPlanLlmOutput {
    return {
      ...llmOutput,
      days: Array.from({ length: days }, (_, i) => ({
        ...llmOutput.days[0]!,
        day_number: i + 1 + offset,
      })),
    };
  }

  it('单段原样返回', () => {
    const only = segment(5, 0);
    expect(mergeSegments([only])).toBe(only);
  });

  it('多段拼接并重新编号', () => {
    /*
     * 重新编号而不是信任各段自己的 day_number：第二段的模型很可能
     * 又从 1 开始编，而 V-02 会因此报 BLOCKING —— 明明只是合并没做对。
     */
    const merged = mergeSegments([segment(7, 0), segment(7, 0)]);
    expect(merged.days).toHaveLength(14);
    expect(merged.days.map((day) => day.day_number)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
  });

  it('constraint_report 按 code 去重', () => {
    // 每段都会重复声明「已满足无障碍要求」，不去重会让约束报告很难读
    const merged = mergeSegments([segment(7, 0), segment(7, 0)]);
    const codes = merged.constraint_report.satisfied.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('保留第一段的标题与目的地', () => {
    const merged = mergeSegments([segment(7, 0), segment(7, 0)]);
    expect(merged.title).toBe(llmOutput.title);
    expect(merged.destination).toEqual(llmOutput.destination);
  });

  it('空数组时抛错', () => {
    expect(() => mergeSegments([])).toThrow(/至少需要一段/);
  });
});

/**
 * P9：多城城市序列与按优先级分段的约束渲染（规范 4.1、7）。
 */
describe('多城与约束分段（P9）', () => {
  const promptFor = (overrides: Partial<typeof normalized>): string =>
    buildPlanPrompt({
      normalized: { ...normalized, ...overrides },
      segment: { startDay: 1, endDay: normalized.total_days },
      totalSegments: 1,
      references: [],
    }).user;

  it('单城时给出「一律填 X」', () => {
    /*
     * 单城也给指令而不是省掉：V-04 校验每日 city 属于城市序列，
     * 而模型在单城行程里也可能自作主张填上一个近郊地名。
     */
    const user = promptFor({});
    expect(user).toContain(`每天的 city 一律填「${normalized.destination_name}」`);
    expect(user).toContain(`目的地：${normalized.destination_name}`);
  });

  it('多城时给出城市序列与集合约束', () => {
    const user = promptFor({ cities: [{ text: '东京' }, { text: '京都' }] });
    expect(user).toContain('城市序列（按此顺序走，不要增删城市）：东京 → 京都');
    expect(user).toContain('必须是城市序列里的一个');
    expect(user).toContain('「东京」、「京都」');
    /*
     * **不**写死「第 N 天填第 M 个城市」：天数与城市数的对应关系该由模型按
     * 景点分布决定（3 天 2 城可以是 2+1 也可以是 1+2）。
     */
    expect(user).toContain('同一个城市的日子要连续');
  });

  it('cities 缺省时退化成 destination_name —— 与 planCities 同结果', () => {
    /*
     * `@tps/llm` 不能依赖 `@tps/planning`（依赖方向相反），因此退化逻辑
     * 在两处各有一份。这条断言盯住它们给出同样的结果。
     */
    const legacy = { ...normalized };
    expect(planCities(legacy).map((city) => city.text)).toEqual([legacy.destination_name]);
    expect(promptFor({})).toContain(`目的地：${legacy.destination_name}`);
  });

  it('弹性日期为 0 时不渲染那一行', () => {
    /* 恒渲染「弹性 0 天」会让模型把「日期固定」当成一个需要考虑的变量 */
    expect(promptFor({})).not.toContain('日期弹性');
    expect(promptFor({ date_flexibility: { days: 0 } })).not.toContain('日期弹性');
  });

  it('有弹性时说明可以调整并要记进 assumptions', () => {
    const user = promptFor({ date_flexibility: { days: 3, mode: 'PLUS_MINUS_3' } });
    expect(user).toContain('前后可浮动 3 天');
    expect(user).toContain('assumptions');
  });

  it('约束按 4.1 的优先级分段，段内带 field_id', () => {
    const user = promptFor({
      constraints: [
        {
          constraint_id: 'LOCKED:PV2-01-009#0',
          type: 'LOCKED',
          source_field_id: 'PV2-01-009',
          text: '已购买且不可移动：住宿「东京湾酒店」',
          decision_weight: 0,
        },
        {
          constraint_id: 'HARD:PV2-07-002',
          type: 'HARD',
          source_field_id: 'PV2-07-002',
          text: '必须遵守的饮食方式：清真',
          decision_weight: 2,
        },
        {
          constraint_id: 'PREFER:PV2-03-004',
          type: 'PREFER',
          source_field_id: 'PV2-03-004',
          text: '整体档次：品质型',
          decision_weight: 6,
        },
      ],
    });

    expect(user).toContain('低优先级不得覆盖高优先级');
    expect(user).toContain('【已购买且不可改动');
    expect(user).toContain('  - [PV2-01-009] 已购买且不可移动：住宿「东京湾酒店」');
    expect(user).toContain('  - [PV2-07-002] 必须遵守的饮食方式：清真');
    expect(user).toContain('  - [PV2-03-004] 整体档次：品质型');

    /*
     * 顺序是这条断言的核心：一段混在一起的文本表达不了优先级，模型会把
     * 「优先安静的酒店」与「已购买不可退的台场酒店」当成同等的两条要求，
     * 然后为了满足前者换掉后者。
     */
    expect(user.indexOf('【已购买且不可改动')).toBeLessThan(user.indexOf('【必须满足'));
    expect(user.indexOf('【必须满足')).toBeLessThan(user.indexOf('【优先满足'));
  });

  it('没有约束时不渲染分段标题', () => {
    const user = promptFor({});
    expect(user).not.toContain('低优先级不得覆盖高优先级');
    expect(user).not.toContain('【必须满足');
  });

  it('空的类型不产出空段落', () => {
    /* 一个只有标题没有条目的段落会让模型以为那一类被刻意留空了 */
    const user = promptFor({
      constraints: [
        {
          constraint_id: 'EXCLUDE:PV2-04-008',
          type: 'EXCLUDE',
          source_field_id: 'PV2-04-008',
          text: '绝对不要安排：红眼航班',
          decision_weight: 3,
        },
      ],
    });
    expect(user).toContain('【绝对不要安排');
    expect(user).not.toContain('【必须满足');
    expect(user).not.toContain('【信息使用授权');
  });
});
