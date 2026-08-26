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
  /*
   * 第 8 条对应 `TotalBudgetSchema` 的两个可选字段。
   *
   * 必须在提示里明说，不能只靠 JSON Schema 里的字段描述：可选字段在结构化输出
   * 里模型完全可以一直不填，而不填的后果是校验层永远拿不到口径、
   * 永远走「按含往返大交通处理」的降级分支 —— 那个降级会记一条 assumption，
   * 于是每份计划都带一句用户看不懂的说明。
   */
  '8. total_budget 里若含往返大交通（机票、跨城铁路等），在 intercity_transport ' +
    '给出这部分金额（它是 transport 的子集）；若含购物，在 shopping 给出金额' +
    '（它是 other 的子集）。不含则省略该字段，不要写 0。',
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
 * 运行时约束的分段渲染（P9，规范 4.1）。
 *
 * ## 为什么必须分段，而不是一串「用户要求：……」
 *
 * 4.1 给了一条优先级：`LOCKED > CONSENT/安全硬约束 > HARD > EXCLUDE > VERIFY >
 * PREFER`，含义是**低优先级不得静默覆盖高优先级**。而一段混在一起的文本
 * 无法表达这件事 —— 模型看到「优先安静的酒店」与「已购买不可退的台场酒店」
 * 并列时，会把它们当成同等的两条要求，然后为了满足前者换掉后者。
 *
 * 分段之后每一段带自己的指令强度（「绝对不可改动」对「尽量满足」），
 * 这是当前唯一能把优先级传达给模型的手段。
 *
 * ## 顺序由 `decision_weight` 决定，不在这里重排
 *
 * `@tps/planning` 的 `sortConstraints` 已经按权重排好。在这里再排一遍会造出
 * 第二个顺序真相源 —— 而两者不一致时，Prompt 里的顺序与约束报告里的顺序
 * 会不同，用户会以为那是两份不同的约束。
 */
const CONSTRAINT_SECTIONS = [
  {
    type: 'LOCKED',
    title: '已购买且不可改动（最高优先级，绝对不能违反、不能改期、不能替换）',
  },
  { type: 'CONSENT', title: '信息使用授权' },
  { type: 'HARD', title: '必须满足（不能满足时不要硬凑，在 constraint_report.violated 里说明）' },
  { type: 'EXCLUDE', title: '绝对不要安排（不得主动出现在行程里）' },
  {
    type: 'VERIFY_BLOCKING',
    title: '尚未核验且影响可行性（安排相关内容时必须在 assumptions 里标明未核验）',
  },
  { type: 'VERIFY_NONBLOCKING', title: '尚未核验（可以安排，但要标明未核验）' },
  { type: 'PREFER', title: '优先满足（与上面各段冲突时可以让步，但要在 assumptions 里说明理由）' },
  { type: 'FACT', title: '事实信息（不要为了让方案更好看而改写）' },
  { type: 'INFO', title: '补充说明（仅供参考，不得据此改写上面任何一条硬约束）' },
] as const;

/**
 * 预算包含项的中文名。
 *
 * 这是仓库里**第一个** `Record<BudgetIncludedItem, string>` —— `enums.ts` 里那段
 * 「加 SHOPPING 是安全的，因为没有任何穷举点」的注释从此不再成立，而这是好事：
 * 往那个枚举加成员现在是编译错误，而不是「界面上多一项、提示里静默漏掉」。
 */
const BUDGET_ITEM_LABEL: Record<
  NormalizedTravelRequest['budget']['included_items'][number],
  string
> = {
  INTERCITY_TRANSPORT: '往返大交通',
  ACCOMMODATION: '住宿',
  MEALS: '餐饮',
  LOCAL_TRANSPORT: '市内交通',
  TICKETS: '门票与活动',
  SHOPPING: '购物',
};

function budgetScopeText(items: NormalizedTravelRequest['budget']['included_items']): string {
  /*
   * 契约的 `.min(1)` 保证非空，因此不必处理空数组 —— 处理它反而会写出一句
   * 「这笔预算覆盖：。」这种读不通的话。
   */
  return items.map((item) => BUDGET_ITEM_LABEL[item]).join('、');
}

function describeConstraints(constraints: NormalizedTravelRequest['constraints']): string[] {
  if (constraints === undefined || constraints.length === 0) return [];

  const lines: string[] = [];
  for (const section of CONSTRAINT_SECTIONS) {
    const items = constraints.filter((constraint) => constraint.type === section.type);
    if (items.length === 0) continue;
    lines.push(`【${section.title}】`);
    /*
     * 每条前面带 field_id。
     *
     * 规范 21.2 要求生成结果保存 `source_field_id` 使推荐可追溯，而模型能在
     * `constraint_report` 里回引它的前提是它在 Prompt 里见过。
     * 不带的话追溯只能靠后端事后按文本匹配 —— 而文本是会被模型改写的。
     */
    for (const item of items) lines.push(`  - [${item.source_field_id}] ${item.text}`);
  }
  return lines;
}

/**
 * 城市序列（P9）。
 *
 * 单城时仍然渲染一行，而不是省掉：省掉的话「每日 city 怎么填」那条指令就得
 * 分两种写法，而两种写法迟早有一种没跟上改动。
 */
function describeCities(cities: readonly { readonly text: string }[]): string {
  return cities.map((city) => city.text).join(' → ');
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

  /*
   * 城市序列。
   *
   * `cities` 是 P9 新增的**可选**字段（陷阱 2），存量行没有它。
   * 这里就地退化成单元素序列而不是调用 `@tps/planning` 的 `planCities`：
   * `@tps/llm` 不依赖 `@tps/planning`（依赖方向是 planning → llm），
   * 反向引用会造成循环。退化逻辑只有一行，且由 `prompt.test.ts` 断言
   * 它与 `planCities` 给出同样的结果。
   */
  const cities =
    normalized.cities !== undefined && normalized.cities.length > 0
      ? normalized.cities
      : [{ text: normalized.destination_name }];
  const multiCity = cities.length > 1;

  const flexibility = normalized.date_flexibility;

  const user = [
    multiCity
      ? `城市序列（按此顺序走，不要增删城市）：${describeCities(cities)}`
      : `目的地：${cities[0]?.text ?? normalized.destination_name}`,
    `出发地：${normalized.origin_name}`,
    `日期：${normalized.start_date} 至 ${normalized.end_date}（共 ${normalized.total_days} 天）`,
    /*
     * 弹性日期只在真有弹性时渲染一行。
     *
     * 恒渲染「弹性 0 天」会让模型把「日期固定」当成一个需要考虑的变量 ——
     * 而它恰恰是「不要动日期」。
     */
    ...(flexibility === undefined || flexibility.days === 0
      ? []
      : [
          `日期弹性：前后可浮动 ${flexibility.days} 天。仍然按上面给的日期排，` +
            '若某项安排只能在窗口内的另一天完成，可以调整并在 assumptions 里说明。',
        ]),
    `出行人数：${normalized.traveler_count} 人${normalized.has_child ? '，含儿童' : ''}${
      normalized.has_senior ? '，含长者' : ''
    }`,
    `预算区间（全程总额，${normalized.budget.currency}）：${normalized.budget.total_min} ～ ${normalized.budget.total_max}`,
    /*
     * 口径必须紧跟区间。
     *
     * 只给 min ～ max 是有二义的：同一个「12000」在「含住宿」与「不含住宿」两种
     * 口径下差出一晚酒店的量级。这句话之前只以 FACT 约束的形式出现在提示末尾
     * （`constraints.ts` 的 PV2-03-006），离预算区间几十行远，而模型要把两处
     * 拼起来才知道这个数字的含义。
     */
    `这笔预算覆盖：${budgetScopeText(normalized.budget.included_items)}。` +
      '不在此列的开支不要计入 total_budget.total。',
    `节奏：每日 ${pace.attractions_per_day_min}～${pace.attractions_per_day_max} 个景点，每日步行不超过 ${pace.walking_limit_km} 公里，最早出发 ${pace.earliest_departure_time}`,
    ...describeConditions('必须满足的条件', normalized.must_conditions),
    ...describeConditions('尽量满足的条件', normalized.should_conditions),
    ...(normalized.custom_text.length > 0 ? [`用户补充说明：${normalized.custom_text}`] : []),
    /*
     * 约束清单放在结构化条件之后。
     *
     * 顺序是刻意的：上面几行是「这趟旅行是什么」，约束清单是「有哪些不能碰的
     * 边界」。反过来的话模型先读到几十条边界再读到目的地，而首要信息应该先出现。
     */
    ...(normalized.constraints === undefined || normalized.constraints.length === 0
      ? []
      : ['', '用户明确表达的约束，按优先级分段。低优先级不得覆盖高优先级：']),
    ...describeConstraints(normalized.constraints),
    '',
    ...describeReferences(references),
    '',
    scope,
    `每天的 date 字段按出发日期顺延填写（第 N 天 = ${normalized.start_date} 加 N-1 天）。`,
    /*
     * 每日 city 的取值规则（P9）。
     *
     * 单城时仍然给出「一律填 X」而不是省掉：V-04 校验每日 city 属于城市序列，
     * 而模型在单城行程里也可能自作主张填上一个近郊地名。
     *
     * 多城时给的是**集合约束 + 连续性建议**，而不是「第 N 天填第 M 个城市」——
     * 天数与城市数的对应关系是模型该决定的（3 天 2 城可以是 2+1 也可以是 1+2），
     * 而写死对应关系会让它无法按景点分布调整。
     */
    multiCity
      ? `每天的 city 必须是城市序列里的一个：${cities.map((city) => `「${city.text}」`).join('、')}。` +
        '同一个城市的日子要连续，不要来回跳；换城市的那一天要在行程里体现城际交通。'
      : `每天的 city 一律填「${cities[0]?.text ?? normalized.destination_name}」。`,
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
