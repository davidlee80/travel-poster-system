import type { LicensedSourceCandidate, LicensedSourceQuery, LicensedSourceClient } from '@tps/llm';
import type { AssetRole } from '@tps/schemas';

/**
 * Fake 授权图源搜索实现。
 *
 * 用于测试：模拟授权图源的命中/未命中/延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **按角色编排**：`byRole` 允许为 Hero / 景点 / 美食分别配置不同的行为；
 * - **延迟模拟**：`delayMs` 模拟搜索 API 响应慢（真实场景下可能是网络延迟或图源服务负载高）；
 * - **故障模拟**：`error` 模拟搜索超时或图源不可用；
 * - **连续失败**：`failTimes` 按角色跨调用计数，用于编排「连续失败触发熔断」的场景 ——
 *   搜索层在单槽位内不重试（9.6：超时即降入 AI 层），且单任务连续失败 2 次后熔断，
 *   之后的搜索根本不会再发起。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/llm/src/image-search.ts`）会：
 * 1. 调用授权图源的搜索 API（如 Unsplash、Pexels）；
 * 2. 下载原图；
 * 3. 校验 MIME/分辨率/授权。
 *
 * Fake 实现**不执行**这些操作，只返回预置的候选列表。这保证了测试的确定性：
 * 不依赖外部 API，不依赖网络，不依赖图源服务的可用性。
 */
export interface FakeLicensedSourceBehavior {
  /** 命中：返回候选列表 */
  readonly candidates?: readonly LicensedSourceCandidate[];
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障：'timeout' | 'unavailable' */
  readonly error?: 'timeout' | 'unavailable';
  /**
   * 连续失败次数（按角色跨调用累计）：前 N 次调用抛错，之后恢复正常。
   * 用于编排「连续失败触发熔断」的场景 —— 这与单槽位重试无关：搜索层在
   * 单槽位内不重试（9.6：超时即降入 AI 层），且单任务连续失败 2 次后熔断
   * （`search-budget.ts`），之后的搜索根本不会再发起。
   */
  readonly failTimes?: number;
}

export interface FakeLicensedSourceOptions {
  /** 按槽位角色编排行为 */
  readonly byRole?: Partial<Record<AssetRole, FakeLicensedSourceBehavior>>;
  /** 全局默认行为 */
  readonly default?: FakeLicensedSourceBehavior;
}

/**
 * 包装 `LicensedSourceClient`，按角色注入编排行为。
 */
export function wrapLicensedSource(
  client: LicensedSourceClient,
  options: FakeLicensedSourceOptions,
): LicensedSourceClient {
  const behaviorFor = (role: AssetRole): FakeLicensedSourceBehavior => {
    return options.byRole?.[role] ?? options.default ?? {};
  };

  // 按角色记录调用次数（用于 failTimes 编排）
  const callCounts = new Map<AssetRole, number>();

  return {
    ...client,
    search: async (query: LicensedSourceQuery, timeoutMs: number) => {
      const role = inferRoleFromQuery(query);
      const behavior = behaviorFor(role);

      // 连续失败编排
      const count = callCounts.get(role) ?? 0;
      callCounts.set(role, count + 1);
      if (behavior.failTimes !== undefined && count < behavior.failTimes) {
        throw new Error(`FakeLicensedSourceClient: 第 ${count + 1} 次调用失败（编排）`);
      }

      if (behavior.error === 'timeout') {
        throw new Error('FakeLicensedSourceClient: 搜索超时（编排）');
      }

      if (behavior.error === 'unavailable') {
        throw new Error('FakeLicensedSourceClient: 图源不可用（编排）');
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      if (behavior.candidates !== undefined) {
        return behavior.candidates.slice(0, query.limit);
      }

      // 默认：调用真实实现
      return client.search(query, timeoutMs);
    },
    download: async (candidate: LicensedSourceCandidate, timeoutMs: number) => {
      // 下载不编排，直接调用真实实现
      return client.download(candidate, timeoutMs);
    },
  };
}

/**
 * 判定一次搜索调用对应的槽位角色。
 *
 * 生产路径经 `search-ingest.ts` 发起，query 里带着 `role`（精确）。
 * 直接单测本 wrapper 时可以不带，此时按槽位约束比例判定 —— 三类图片
 * 槽位互不相同（16:6 Hero / 4:3 美食 / 16:9 景点，见 `@tps/presentation`
 * 的 requirements.ts），它是槽位约束的直接透传，必然存在。`ROUTE_MAP`
 * 在预算闸就被拒绝，搜索永远不会为它发起。
 *
 * 曾经按检索词里的关键词猜：检索词是构造给向量模型与图源看的文本，
 * 措辞一变，编排就静默落进错误的角色分支 —— 测试看起来还在跑，
 * 实际验的已经不是那条链。
 */
function inferRoleFromQuery(query: LicensedSourceQuery): AssetRole {
  if (query.role !== undefined) return query.role;

  switch (query.aspectRatio) {
    case '16:6':
      return 'HERO_BACKGROUND';
    case '4:3':
      return 'FOOD_IMAGE';
    default:
      return 'DESTINATION_PHOTO';
  }
}

export { inferRoleFromQuery as _inferRoleFromQueryForTest };
