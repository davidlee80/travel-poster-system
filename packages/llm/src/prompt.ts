import type {
  NormalizedTravelRequest,
  RetrievalProjection,
  TravelPlanLlmOutput,
} from '@tps/schemas';

/**
 * 计划生成的提示与分段策略（TP-2-11，设计稿 6.3、3.2.2、3.2.4）。
 *
 * 6.3 的五条约束在这里各有落点：
 *   单个 JSON 对象 + 结构化输出   → `client.ts` 的 `response_format`
 *   ID 由程序注入                 → `TravelPlanLlmOutputSchema` 不含 ID，
 *                                   且提示里明确要求不要生成
 *   剥离 URL / HTML               → 提示里要求 + V-45 兜底
 *   `max_tokens` 按天数分档       → `maxTokensForDays`
 *   超过 7 天分段生成后合并       → `planSegments` + `mergeSegments`
 */

/**
 * 6.3 的 token 分档。
 *
 * 分档而不是一律用最大值：`max_tokens` 直接决定单次调用的成本上限，
 * 而 1 天的行程用 48K 额度毫无意义。给太小则更糟 —— 输出在中途被截断，
 * 表现为「第 9 天之后什么都没有」，而截断的 JSON 连解析都过不去。
 */
export const MAX_TOKENS_TIERS = [
  { maxDays: 5, maxTokens: 16_384 },
  { maxDays: 10, maxTokens: 32_768 },
  { maxDays: 14, maxTokens: 49_152 },
] as const;

export function maxTokensForDays(totalDays: number): number {
  for (const tier of MAX_TOKENS_TIERS) {
    if (totalDays <= tier.maxDays) return tier.maxTokens;
  }
  /*
   * 超过 14 天不该走到这里（N-03 已经在同步校验里拦住）。
   * 用最高档兜底而不是抛错：这条路径若真被走到，说明校验被绕过了，
   * 而那时「生成一份可能被截断的计划」仍然好过「任务直接崩」。
   */
  return MAX_TOKENS_TIERS[MAX_TOKENS_TIERS.length - 1]!.maxTokens;
}

/** 6.3：超过 7 天的行程分段生成，每段 ≤ 7 天 */
export const MAX_DAYS_PER_SEGMENT = 7;

export interface PlanSegment {
  /** 1 起，含首尾 */
  readonly startDay: number;
  readonly endDay: number;
}

/**
 * 切分天数。
 *
 * 14 天切成 7 + 7，而不是 7 + 7 之外还留一个 0 天的空段。
 * 空段会让第二次调用要求模型「生成 0 天的行程」，而模型通常会自己补一天 ——
 * 合并后天数比请求多，V-01 报 BLOCKING。
 */
export function planSegments(totalDays: number): readonly PlanSegment[] {
  if (totalDays <= MAX_DAYS_PER_SEGMENT) {
    return [{ startDay: 1, endDay: Math.max(1, totalDays) }];
  }

  const segments: PlanSegment[] = [];
  for (let start = 1; start <= totalDays; start += MAX_DAYS_PER_SEGMENT) {
    segments.push({
      startDay: start,
      endDay: Math.min(start + MAX_DAYS_PER_SEGMENT - 1, totalDays),
    });
  }
  return segments;
}

export interface PromptMessages {
  readonly system: string;
  readonly user: string;
}

/**
 * 系统提示：只讲**格式与禁令**，不讲具体行程。
 *
 * 与用户提示分开是为了让「不许生成什么」这部分固定下来 ——
 * 它与具体请求无关，混在用户提示里会随每次请求被重写，
 * 而漏掉其中一条（尤其是 URL 与 ID 那两条）不会有任何直接症状。
 */
export const PLAN_SYSTEM_PROMPT = [
  '你是一位熟悉中国城市与近郊旅行的行程规划师。',
  '',
  '输出要求（全部为硬性约束）：',
  '1. 只输出一个 JSON 对象，符合给定的 JSON Schema，不要输出任何解释文字或代码块标记。',
  '2. 不要生成 plan_id、plan_version_id、request_id 等任何标识符字段，它们由程序填写。',
  '3. 正文中不得出现网址、协议头（http:// 等）、HTML 标签或尖括号。',
  '4. 不要使用 Markdown 标记（**、#、- 列表、反引号）。',
  '5. 所有文字用简体中文；金额只写数字，币种由字段单独表示。',
  '6. 每条行程的 child_friendly 按该安排是否适合携带儿童如实标注。',
  '7. 时间用 24 小时制 HH:mm；结束时间必须晚于开始时间，且与 duration_minutes 一致。',
].join('\n');

export interface PlanPromptInput {
  readonly normalized: NormalizedTravelRequest;
  readonly segment: PlanSegment;
  readonly totalSegments: number;
  /** 3.2.4 检索到的脱敏投影。空数组表示无历史参考 */
  readonly references: readonly RetrievalProjection[];
}

function describeConditions(
  label: string,
  conditions: NormalizedTravelRequest['must_conditions'],
): string[] {
  if (conditions.length === 0) return [];
  return [`${label}：${conditions.map((condition) => condition.code).join('、')}`];
}

/**
 * 把脱敏投影渲染成参考资料。
 *
 * 只渲染投影里有的字段 —— 它本身已经不含日期、金额与人员构成（3.2.4）。
 * 这里**不做二次裁剪**：裁剪逻辑只应存在于 `buildRetrievalProjection` 一处，
 * 两处各裁一遍的话，哪一处才是权威就说不清了。
 */
function describeReferences(references: readonly RetrievalProjection[]): string[] {
  if (references.length === 0) {
    return ['历史参考：无。请完全按上述需求新拟行程。'];
  }

  const lines = ['历史参考（同目的地、天数相近的既有行程结构，仅供参考，不要照抄）：'];
  references.forEach((reference, index) => {
    lines.push(`参考 ${index + 1}（共 ${reference.total_days} 天）：`);
    reference.days.forEach((day, dayIndex) => {
      const pois = day.schedule.map((item) => item.location.name).join(' → ');
      lines.push(`  第 ${dayIndex + 1} 天「${day.theme}」：${pois}`);
    });
  });
  return lines;
}

export function buildPlanPrompt(input: PlanPromptInput): PromptMessages {
  const { normalized, segment, totalSegments, references } = input;
  const pace = normalized.pace;

  const scope =
    totalSegments === 1
      ? `请生成第 1 天到第 ${normalized.total_days} 天的完整行程。`
      : `本次只生成**第 ${segment.startDay} 天到第 ${segment.endDay} 天**的行程（整趟共 ${normalized.total_days} 天，分 ${totalSegments} 段生成）。days 数组只包含这几天。`;

  const user = [
    `目的地：${normalized.destination_name}`,
    `出发地：${normalized.origin_name}`,
    `日期：${normalized.start_date} 至 ${normalized.end_date}（共 ${normalized.total_days} 天）`,
    `出行人数：${normalized.traveler_count} 人${normalized.has_child ? '，含儿童' : ''}${
      normalized.has_senior ? '，含长者' : ''
    }`,
    `预算区间（全程总额，${normalized.budget.currency}）：${normalized.budget.total_min} ～ ${normalized.budget.total_max}`,
    `节奏：每日 ${pace.attractions_per_day_min}～${pace.attractions_per_day_max} 个景点，每日步行不超过 ${pace.walking_limit_km} 公里，最早出发 ${pace.earliest_departure_time}`,
    ...describeConditions('必须满足的条件', normalized.must_conditions),
    ...describeConditions('尽量满足的条件', normalized.should_conditions),
    ...(normalized.custom_text.length > 0 ? [`用户补充说明：${normalized.custom_text}`] : []),
    '',
    ...describeReferences(references),
    '',
    scope,
    `每天的 date 字段按出发日期顺延填写（第 N 天 = ${normalized.start_date} 加 N-1 天），city 一律填「${normalized.destination_name}」。`,
  ].join('\n');

  return { system: PLAN_SYSTEM_PROMPT, user };
}

export interface RepairPromptInput {
  readonly normalized: NormalizedTravelRequest;
  /** 3.2.2：违规清单 + 上一版该日内容 */
  readonly violations: readonly {
    readonly rule: string;
    readonly path: string;
    readonly detail: string;
  }[];
  readonly previous: TravelPlanLlmOutput;
  readonly attempt: number;
}

/**
 * 定向重生成的提示（3.2.2 第二级）。
 *
 * 把**上一版内容与违规清单**都给模型，而不是重发一次原始需求：
 * 重发原始需求得到的是另一份随机结果，同样的问题很可能再犯一次；
 * 带上「你上次这样写，这几条不合规」才是定向。
 */
export function buildRepairPrompt(input: RepairPromptInput): PromptMessages {
  const { normalized, violations, previous, attempt } = input;

  const user = [
    `这是第 ${attempt} 次修正请求。下面是上一版行程，以及它未通过的校验项。`,
    '请在保持整体结构与已通过内容不变的前提下，只修正这些问题，并输出完整的 JSON 对象。',
    '',
    '未通过的校验项：',
    ...violations.map(
      (violation) => `- [${violation.rule}] ${violation.path}：${violation.detail}`,
    ),
    '',
    `硬性约束提醒：目的地 ${normalized.destination_name}，共 ${normalized.total_days} 天，` +
      `出发日期 ${normalized.start_date}。` +
      (normalized.must_conditions.length > 0
        ? `必须满足的条件：${normalized.must_conditions.map((c) => c.code).join('、')}，` +
          '并在 constraint_report.satisfied 中逐条列出。'
        : ''),
    '',
    '上一版行程：',
    JSON.stringify(previous),
  ].join('\n');

  return { system: PLAN_SYSTEM_PROMPT, user };
}

/**
 * 合并分段输出（6.3）。
 *
 * 取第一段作为整体骨架（title / summary / destination / 预算），
 * `days` 按段顺序拼接并重新编号。
 *
 * 预算不在这里累加：`total_budget` 由 V-20 从各日 `breakdown` 重算
 * （见 @tps/planning 的 deriveBudget）。在两处各算一遍必然出现不一致，
 * 而 V-20 是那个数字的唯一权威。
 */
export function mergeSegments(segments: readonly TravelPlanLlmOutput[]): TravelPlanLlmOutput {
  const first = segments[0];
  if (first === undefined) {
    throw new Error('mergeSegments 至少需要一段输出');
  }
  if (segments.length === 1) return first;

  const days = segments
    .flatMap((segment) => segment.days)
    .map((day, index) => ({ ...day, day_number: index + 1 }));

  /*
   * constraint_report 按 code 去重合并：分段生成时每段都会重复声明
   * 「已满足无障碍要求」，不去重会让 satisfied 里出现 N 份同样的条目，
   * 而 V-32 的满足率是按 code 集合算的 —— 重复不影响它，
   * 但用户看到的约束报告会很难读。
   */
  const dedupe = <T extends { code: string }>(items: readonly T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
  };

  return {
    ...first,
    days,
    constraint_report: {
      satisfied: dedupe(segments.flatMap((segment) => segment.constraint_report.satisfied)),
      violated: dedupe(segments.flatMap((segment) => segment.constraint_report.violated)),
      assumptions: dedupe(segments.flatMap((segment) => segment.constraint_report.assumptions)),
    },
  };
}
