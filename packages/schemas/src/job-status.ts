import { z } from 'zod';

/**
 * 任务状态机（TP-2-16，设计稿十六章、16.1、16.2）。
 *
 * ## 为什么状态机在 schemas 里
 *
 * 三方共用同一张表：`apps/api` 读它返回 `progress` / `message`（13.2）、
 * `apps/generation-worker` 写它推进状态、数据库的 CHECK 约束限定取值。
 * 三处各写一份的失效模式是「Worker 写了个 API 不认识的状态」——
 * 而 13.2 是查表返回的，查不到就返回 `undefined`，前端进度条卡住不动，
 * 任务其实还在正常跑。
 */

export const JOB_STATUS_VALUES = [
  'QUEUED',
  'NORMALIZING',
  'VALIDATING_REQUEST',
  'RETRIEVING_REFERENCES',
  'GENERATING_PLAN',
  'VALIDATING_PLAN',
  'REPAIRING_PLAN',
  'SAVING_PLAN',
  'BUILDING_PRESENTATION',
  'RESOLVING_ASSETS',
  'GENERATING_ASSETS',
  'RENDERING_HTML',
  'EXPORTING_PNG',
  'EXPORTING_PDF',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

/** 16.1：终态不可再转移 */
export const TERMINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/**
 * 16.2：`progress` 与用户提示文案。
 *
 * `progress` 为 `null` 表示**保持进入该状态时的值**：
 *   `FAILED`    16.2「保持进入失败时的值」
 *   `CANCELLED` 16.2「保持当前值」
 *
 * `message` 为 `null` 表示文案不由状态决定：`FAILED` 取 13.7 错误码对应文案。
 * 用 `null` 而不是给一句「生成失败」占位：占位文案会覆盖掉真正有用的
 * 「当前必选条件无法同时满足，请放宽部分条件后重试」，而那句话是用户
 * 唯一的下一步指引。
 */
export interface JobStageDisplay {
  readonly progress: number | null;
  readonly message: string | null;
}

export const JOB_STAGE_DISPLAY: Record<JobStatus, JobStageDisplay> = {
  QUEUED: { progress: 0, message: '已加入队列，正在等待处理' },
  NORMALIZING: { progress: 4, message: '正在整理你的旅行需求' },
  VALIDATING_REQUEST: { progress: 8, message: '正在检查需求是否可行' },
  RETRIEVING_REFERENCES: { progress: 14, message: '正在检索目的地资料' },
  GENERATING_PLAN: { progress: 20, message: '正在生成旅行计划，这一步需要稍等' },
  VALIDATING_PLAN: { progress: 48, message: '正在校验行程安排' },
  REPAIRING_PLAN: { progress: 54, message: '正在优化行程细节' },
  SAVING_PLAN: { progress: 60, message: '正在保存旅行计划' },
  BUILDING_PRESENTATION: { progress: 66, message: '正在编排页面内容' },
  RESOLVING_ASSETS: { progress: 76, message: '正在准备旅行计划图片和路线图' },
  GENERATING_ASSETS: { progress: 82, message: '正在生成主题插画' },
  RENDERING_HTML: { progress: 90, message: '正在生成计划页面' },
  EXPORTING_PNG: { progress: 94, message: '正在导出长图' },
  EXPORTING_PDF: { progress: 97, message: '正在导出 PDF' },
  COMPLETED: { progress: 100, message: '旅行计划已生成' },
  FAILED: { progress: null, message: null },
  CANCELLED: { progress: null, message: '已取消生成' },
};

/**
 * 16.1 的合法转移边。
 *
 * 只有两条回边：`REPAIRING_PLAN → VALIDATING_PLAN` 与
 * `GENERATING_ASSETS → RESOLVING_ASSETS`。其余严格前向，防止状态机成环。
 *
 * `FAILED` 与 `CANCELLED` 不在各状态的出边里，由 `canTransition` 统一处理：
 * 16.1 说「任意状态 → FAILED」「任意非终态 → CANCELLED」，
 * 逐个状态列一遍会让这张表多出 30 条重复条目，而漏掉其中一条的表现是
 * 「某个阶段出错时任务卡死而不是失败」。
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ['NORMALIZING'],
  NORMALIZING: ['VALIDATING_REQUEST'],
  VALIDATING_REQUEST: ['RETRIEVING_REFERENCES'],
  RETRIEVING_REFERENCES: ['GENERATING_PLAN'],
  GENERATING_PLAN: ['VALIDATING_PLAN'],
  VALIDATING_PLAN: ['SAVING_PLAN', 'REPAIRING_PLAN'],
  // 回边：修复成功后重跑校验，受 3.2.2 的迭代上限约束
  REPAIRING_PLAN: ['VALIDATING_PLAN'],
  SAVING_PLAN: ['BUILDING_PRESENTATION'],
  BUILDING_PRESENTATION: ['RESOLVING_ASSETS'],
  RESOLVING_ASSETS: ['GENERATING_ASSETS', 'RENDERING_HTML'],
  // 回边：AI 兜底后重新解析，最多 1 次
  GENERATING_ASSETS: ['RESOLVING_ASSETS'],
  /*
   * 导出可跳过：`generate_png` / `generate_pdf` 为 false 时直接往后走。
   * 因此 RENDERING_HTML 可以直接到 COMPLETED —— 少了这条边，
   * 两个导出开关都关掉的任务会卡在 RENDERING_HTML。
   */
  RENDERING_HTML: ['EXPORTING_PNG', 'EXPORTING_PDF', 'COMPLETED'],
  EXPORTING_PNG: ['EXPORTING_PDF', 'COMPLETED'],
  EXPORTING_PDF: ['COMPLETED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (isTerminalJobStatus(from)) return false;
  // 16.1：任意状态 → FAILED（仅阻断类错误）；任意非终态 → CANCELLED
  if (to === 'FAILED' || to === 'CANCELLED') return true;
  return JOB_TRANSITIONS[from].includes(to);
}

/**
 * 计算进入 `next` 状态后的 `progress`。
 *
 * 16.2：**回边不回退 progress**。`REPAIRING_PLAN(54) → VALIDATING_PLAN(48)`
 * 时停留在 54 —— 进度条倒退会让用户以为出了问题重新开始，
 * 而实际上任务在正常推进。因此取 `max` 而不是直接查表。
 *
 * 这也是「`progress` 单调不减」这条不变量的唯一实现点：写状态与写进度在
 * 同一事务（16.1），而进度值只经过这个函数。
 */
export function nextProgress(current: number, next: JobStatus): number {
  const table = JOB_STAGE_DISPLAY[next].progress;
  if (table === null) return current;
  return Math.max(current, table);
}

/** 13.2 的 `message`。`FAILED` 需要调用方传入错误码对应文案 */
export function stageMessage(status: JobStatus, errorMessage?: string): string {
  const message = JOB_STAGE_DISPLAY[status].message;
  if (message !== null) return message;
  return errorMessage ?? '生成未完成，请重试。';
}
