import type { AspectRatio, AssetRole, AssetWarningCode, LicenseType } from '@tps/schemas';

import { LlmConfigError } from './config.js';

/**
 * 授权图源联网搜索客户端（TP-6-02，设计稿 9.6、21.4 的 R-45）。
 *
 * ## 它在降级链的哪一层
 *
 * ```text
 * 0  缓存键命中 / 素材库匹配
 * 1  **授权图源搜索**（本文件）→ AI 生成
 * 2  默认占位图 / 文字路线
 * 3  跳过（模板隐藏槽位）
 * ```
 *
 * P3 把等级 1 留空、P4 只填了 AI，本文件补上前半。三条链（Hero / 景点 / 美食）
 * 统一走这一层 —— 9.6 的 R-45 指出原本三类图里唯一跳过搜索直接进 AI 的
 * 恰是最贵的那张（Hero：尺寸最大、10～40 秒、成本最高）。
 *
 * ## 为什么放在 @tps/llm
 *
 * 它与 `client.ts`（文本模型）、`image.ts`（图片模型）是同一类东西：
 * 对外部供应商的 HTTP 客户端 + `fake`/`direct` 模式切换 + 超时与错误映射。
 * 第三份不另起一个包 —— 三者共用 `LlmConfigError` 与同一套「配置缺失即
 * 启动失败」的判定，分开只会让同一个决定在三处各写一遍。
 *
 * 它**不是**模型调用：不产生 token、不计 `cost_units`。日预算因此单独一个
 * 计数（见 `apps/generation-worker/src/assets/search-budget.ts`）。
 *
 * ## 本轮只交付 fake 与适配器接口
 *
 * P6 开工前的确认事项之一是「授权图源供应商」，结论是暂不选定。因此：
 *
 *   - `IMAGE_SEARCH_MODE=fake`（默认）：`FakeLicensedSourceClient`，
 *     可编排超时与失败，9.6 的三条约束（5 秒、单任务 8 次、连续失败 2 次
 *     停用）与整条入库流水线全部走**真实代码路径**，只有 HTTP 那一段是假的；
 *   - `IMAGE_SEARCH_MODE=direct`：**启动即失败**。
 *
 * 后者是有意的。做成「运行时发现没有适配器就跳过搜索层」的话，
 * 「忘记接图源」的表现是「搜索层永远静默跳过」—— 那与 9.6 的全局熔断
 * 在指标图上完全一样，而两者该有的处置正好相反（一个是去接图源，
 * 一个是别再花钱）。接入一个真实图源时要做的是：实现本文件的
 * `LicensedSourceClient` 并在 `createLicensedSourceClient` 的 `direct`
 * 分支返回它，其余代码不动。
 *
 * ## 白名单落配置，不接受运行时添加
 *
 * 9.6：「图源白名单落配置，不接受运行时添加。禁止抓取无授权来源 ——
 * 版权不明的图一旦入库会被后续所有请求长期复用，污染是累积性的。」
 * 因此 `providers` 只从 `IMAGE_SEARCH_PROVIDERS` 读，没有任何 API
 * 可以往里加。
 */

// ── 契约 ────────────────────────────────────────────────────

export interface LicensedSourceQuery {
  /** 检索词。由槽位上下文构造（9.6：打标来源是 AssetRequirement） */
  readonly text: string;
  readonly aspectRatio: AspectRatio;
  readonly minWidth: number;
  /** 候选数上限。逐个尝试直到有一个通过入库门禁 */
  readonly limit: number;
  /**
   * 槽位角色（可选，用于测试编排）。
   *
   * 生产代码（`search-ingest.ts`）会带上它；真实实现忽略该字段、按 `text`
   * 检索，fake 实现用它做精确的按角色编排（`FakeLicensedSourceOptions.byRole`）。
   */
  readonly role?: AssetRole;
}

/**
 * 一个搜索候选。
 *
 * `licenseType` 可为 `null` —— 图源没给出可映射的授权信息时就是这个值，
 * 而 9.6 的入库门禁据此丢弃它。**不在这里用默认值填上**：默认值等于
 * 替图源做了一个法务判断，而这一层的全部意义就是不做那个判断。
 */
export interface LicensedSourceCandidate {
  readonly provider: string;
  /** 图源上的页面地址，写入 `assets.original_url`（举证用） */
  readonly originalUrl: string;
  readonly downloadUrl: string;
  readonly licenseType: LicenseType | null;
  readonly attributionText: string | null;
  /** 授权到期日，写入 `assets.license_expires_at`（19.3 据此自动退出检索） */
  readonly licenseExpiresAt: Date | null;
  readonly mimeType: string | null;
}

export interface LicensedSourceClient {
  /** 白名单快照，来自配置 */
  readonly providers: readonly string[];
  search(
    query: LicensedSourceQuery,
    timeoutMs: number,
  ): Promise<readonly LicensedSourceCandidate[]>;
  download(candidate: LicensedSourceCandidate, timeoutMs: number): Promise<Uint8Array>;
}

export class ImageSearchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageSearchTimeoutError';
  }
}

export class ImageSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageSearchUnavailableError';
  }
}

/**
 * 13.7 的告警码映射。
 *
 * 恒为一个值不是偷懒 —— 9.6 明确「13.7 不需要新错误码」。超时与不可用在
 * **处置**上没有区别（都是降入 AI 层、都不重试），分成两个码只会让
 * `generation_jobs.warnings` 多一个取值而没有任何一方按它分流。
 * 具体原因在日志的 `reason_code` 与 `travel_asset_search_total` 的
 * `outcome` 标签里。
 */
export function searchWarningCode(_error: unknown): AssetWarningCode {
  return 'ASSET_LICENSED_SOURCE_UNAVAILABLE';
}

// ── 配置 ────────────────────────────────────────────────────

export type ImageSearchMode = 'fake' | 'direct';

/**
 * 没有 `gateway`：企业 AI 网关代理的是模型调用，不代理第三方图库的检索 API
 * （它没有那些图库的凭据，也不该有 —— 图源授权是本产品与图库之间的合约）。
 */
export const IMAGE_SEARCH_MODES: readonly ImageSearchMode[] = ['fake', 'direct'];

/** 9.6：单次搜索超时 5 秒。可下调，不可上调 */
export const IMAGE_SEARCH_TIMEOUT_MS = 5_000;

/**
 * 全局日预算的默认阈值（9.6 的 `BUDGET_IMAGE_SEARCH_DAILY`）。
 *
 * 2000 = RISK-08 的种子素材规模（Top 50 目的地、≥ 2000 条）。取这个数的
 * 理由与 AI 图片的 600 同构：**一天之内搜索入库量相当于整个种子库规模**，
 * 说明冷组合命中出了问题（要么主题桶归一化失效，要么素材库覆盖崩了），
 * 此时继续外呼不如降级并告警。
 */
export const DEFAULT_IMAGE_SEARCH_DAILY_BUDGET = 2_000;

export interface ImageSearchConfig {
  readonly mode: ImageSearchMode;
  readonly providers: readonly string[];
  readonly timeoutMs: number;
  readonly dailyBudget: number;
}

function readEnv(env: Record<string, string | undefined>, key: string): string {
  return env[key]?.trim() ?? '';
}

export function loadImageSearchConfig(
  env: Record<string, string | undefined> = process.env,
): ImageSearchConfig {
  const raw = readEnv(env, 'IMAGE_SEARCH_MODE') || 'fake';
  if (!IMAGE_SEARCH_MODES.includes(raw as ImageSearchMode)) {
    throw new LlmConfigError(
      `IMAGE_SEARCH_MODE 取值非法：${raw}（应为 ${IMAGE_SEARCH_MODES.join(' / ')}）`,
    );
  }
  const mode = raw as ImageSearchMode;

  if (mode === 'direct') {
    /*
     * 见文件头「本轮只交付 fake 与适配器接口」。这条错误消息里写了
     * 接入步骤，因为看到它的人正是要做那件事的人。
     */
    throw new LlmConfigError(
      'IMAGE_SEARCH_MODE=direct，但本仓库尚未接入任何授权图源适配器（P6 交付边界）。' +
        '接入方式：实现 packages/llm/src/image-search.ts 的 LicensedSourceClient，' +
        '并在 createLicensedSourceClient 的 direct 分支返回它。',
    );
  }

  const timeoutRaw = readEnv(env, 'IMAGE_SEARCH_TIMEOUT_MS');
  const timeoutMs = timeoutRaw === '' ? IMAGE_SEARCH_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LlmConfigError(`IMAGE_SEARCH_TIMEOUT_MS 取值非法：${timeoutRaw}`);
  }
  if (timeoutMs > IMAGE_SEARCH_TIMEOUT_MS) {
    /*
     * 与 IMAGE_TIMEOUT_MS 同一处理（见 image.ts）。9.6 的 5 秒是从
     * 「搜索是冷路径，不占 800 毫秒的库内单槽位预算」推出来的：
     * 允许配大等于允许一行配置静默推翻 21.2 的时延预算，
     * 而违约会以「偶发 T2 超时」出现，无从关联到这一行。
     */
    throw new LlmConfigError(
      `IMAGE_SEARCH_TIMEOUT_MS 不得超过 ${IMAGE_SEARCH_TIMEOUT_MS}（9.6：单次搜索超时 5 秒）`,
    );
  }

  const budgetRaw = readEnv(env, 'IMAGE_SEARCH_DAILY_BUDGET');
  const dailyBudget = budgetRaw === '' ? DEFAULT_IMAGE_SEARCH_DAILY_BUDGET : Number(budgetRaw);
  if (!Number.isInteger(dailyBudget) || dailyBudget < 0) {
    throw new LlmConfigError(`IMAGE_SEARCH_DAILY_BUDGET 取值非法：${budgetRaw}`);
  }

  return {
    mode,
    providers: parseProviders(readEnv(env, 'IMAGE_SEARCH_PROVIDERS')),
    timeoutMs,
    dailyBudget,
  };
}

/** 逗号分隔 → 去空白 → 去空项 → 去重。重复项会让日预算被同一图源算两次 */
function parseProviders(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

// ── fake 实现 ───────────────────────────────────────────────

/** 单次调用的编排行为。用尽后回到正常返回 */
export type FakeSearchBehavior = 'timeout' | 'unavailable';

export interface FakeLicensedSourceOptions {
  readonly providers?: readonly string[];
  readonly candidates?: readonly LicensedSourceCandidate[];
  /** `search` 的逐次行为脚本 */
  readonly behaviors?: readonly FakeSearchBehavior[];
  /** `download` 的逐次行为脚本 */
  readonly downloadBehaviors?: readonly FakeSearchBehavior[];
  /** `download` 返回的字节 */
  readonly bytes?: Uint8Array;
}

/**
 * 可编排的假图源。
 *
 * 有了行为脚本，9.6 的「连续失败 2 次即停用」与「超时不重试」可以在
 * 单测里精确构造 —— 那两条是**时延**约束，靠真实图源的偶发抖动是测不出来的。
 */
export class FakeLicensedSourceClient implements LicensedSourceClient {
  readonly searchCalls: LicensedSourceQuery[] = [];
  readonly downloadCalls: LicensedSourceCandidate[] = [];

  private readonly behaviors: FakeSearchBehavior[];
  private readonly downloadBehaviors: FakeSearchBehavior[];

  constructor(private readonly options: FakeLicensedSourceOptions = {}) {
    this.behaviors = [...(options.behaviors ?? [])];
    this.downloadBehaviors = [...(options.downloadBehaviors ?? [])];
  }

  get providers(): readonly string[] {
    return this.options.providers ?? [];
  }

  /*
   * `async` 而不是返回 `Promise.resolve` 的同步函数：编排的失败必须以
   * **拒绝**的形式出现。同步 throw 会绕过调用方的 `.catch()`，
   * 而真实 HTTP 客户端的失败一定是拒绝 —— 假实现的失败形状必须一致，
   * 否则单测验证过的降级路径在接上真实图源后是另一条路径。
   */
  async search(
    query: LicensedSourceQuery,
    _timeoutMs: number,
  ): Promise<readonly LicensedSourceCandidate[]> {
    this.searchCalls.push(query);
    throwIfScripted(this.behaviors.shift(), '搜索');

    const candidates = this.options.candidates;
    if (candidates === undefined) {
      /*
       * 未提供候选源即视为图源不可用，而不是返回空数组。
       * 空数组的语义是「搜了，一张都没匹配上」——那是正常结果，
       * 走的是「记 warnings 并降入 AI」之外的另一条分支（不记 warning）。
       * 两者混在一起会让「没接图源」的部署看起来一切正常。
       */
      throw new ImageSearchUnavailableError('FakeLicensedSourceClient 未提供候选源');
    }
    return Promise.resolve(candidates.slice(0, query.limit));
  }

  async download(candidate: LicensedSourceCandidate, _timeoutMs: number): Promise<Uint8Array> {
    this.downloadCalls.push(candidate);
    throwIfScripted(this.downloadBehaviors.shift(), '下载');
    return Promise.resolve(this.options.bytes ?? new Uint8Array());
  }
}

function throwIfScripted(behavior: FakeSearchBehavior | undefined, action: string): void {
  if (behavior === 'timeout') {
    throw new ImageSearchTimeoutError(`授权图源${action}超时（fake 编排）`);
  }
  if (behavior === 'unavailable') {
    throw new ImageSearchUnavailableError(`授权图源${action}不可用（fake 编排）`);
  }
}

export interface CreateLicensedSourceClientOptions {
  /** `fake` 模式下的候选源。缺省时 `search` 抛不可用（降级链因此可测） */
  readonly candidates?: readonly LicensedSourceCandidate[];
  readonly bytes?: Uint8Array;
}

export function createLicensedSourceClient(
  config: ImageSearchConfig,
  options: CreateLicensedSourceClientOptions = {},
): LicensedSourceClient {
  /*
   * `direct` 在 loadImageSearchConfig 就已经抛掉了，因此这里只剩 fake。
   * 不写成 `if (config.mode === 'direct') throw`：那会让「配置校验」这件事
   * 有两个执行点，接入真实适配器时容易只改一处。
   */
  return new FakeLicensedSourceClient({
    providers: config.providers,
    ...(options.candidates === undefined ? {} : { candidates: options.candidates }),
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
  });
}
