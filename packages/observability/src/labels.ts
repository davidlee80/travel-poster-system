/**
 * 允许作为指标标签的名称白名单（设计稿 21.3、二十章）。
 *
 * 这里用 TypeScript 类型而不是 ESLint 规则来强制约束，原因：
 * 类型检查在编译期生效且无法用 eslint-disable 绕过，而高基数标签打爆
 * Prometheus 是不可逆的生产事故（内存暴涨 → 抓取超时 → 监控盲区，
 * 恰好在最需要监控的时候）。
 *
 * 判断某个标签能否加入白名单的唯一标准：**取值集合是否有界且很小**。
 *   user_type 只有 2 个取值      → 可以
 *   user_id 有无限多取值         → 绝对不行
 *   destination 有数千取值        → 不行（用日志或专门的分析表）
 *   rule_id 有 28 个取值（V-xx）  → 可以
 */
export const ALLOWED_LABELS = [
  // 通用
  'service',
  'outcome',
  'status',
  'reason_code',
  'error_code',
  'stage',

  // 身份（R-13）—— 只允许身份「类型」，绝不允许身份「标识」
  'user_type',

  // 任务
  'milestone',
  'total_days_bucket',

  // LLM 与校验
  'model',
  'purpose',
  'rule_id',
  'severity',

  // 素材
  'role',
  'strategy',
  'source',

  // 渲染与导出
  'template_id',
  'page_type',
  'format',
  'scope',

  // 身份事件（R-13）
  'event',
] as const;

export type AllowedLabel = (typeof ALLOWED_LABELS)[number];

/**
 * 明确禁止的标签名。写进类型是为了让误用产生**可读的编译错误**
 * 而不是「类型 'user_id' 不可赋给类型 'service' | ...」这种一长串联合类型报错。
 */
export type ForbiddenLabel =
  | 'user_id'
  | 'userId'
  | 'email'
  | 'plan_id'
  | 'planId'
  | 'job_id'
  | 'jobId'
  | 'request_id'
  | 'requestId'
  | 'trace_id'
  | 'traceId'
  | 'session_id'
  | 'ip'
  | 'created_ip'
  | 'destination'
  | 'entity_name'
  | 'slot_id'
  | 'cache_key';

/**
 * 标签名校验：禁用名给出定向报错，其余必须在白名单内。
 *
 * 用法见 metrics.ts。这些 ID 属于**日志与 trace** 的职责
 * （日志有 request_id/trace_id/job_id/user_id，见 @tps/shared 的 logger），
 * 指标只负责聚合，两者分工不能混。
 */
export type ValidLabel<T extends string> = T extends ForbiddenLabel
  ? `❌ 禁止把高基数或个人数据字段用作指标标签："${T}"。它属于日志/trace 的职责（见设计稿 21.3、二十章）。`
  : T extends AllowedLabel
    ? T
    : `❌ 未登记的指标标签："${T}"。请先确认取值集合有界，再加入 @tps/observability 的 ALLOWED_LABELS。`;

/** 运行期兜底校验：给非 TypeScript 调用方与动态构造的场合留一道防线 */
export function assertAllowedLabels(metricName: string, labels: readonly string[]): void {
  const allowed = new Set<string>(ALLOWED_LABELS);
  const offenders = labels.filter((l) => !allowed.has(l));
  if (offenders.length > 0) {
    throw new Error(
      `指标 "${metricName}" 使用了未登记的标签: ${offenders.join(', ')}。` +
        `高基数标签会打爆 Prometheus（设计稿 21.3、二十章）。`,
    );
  }
}
