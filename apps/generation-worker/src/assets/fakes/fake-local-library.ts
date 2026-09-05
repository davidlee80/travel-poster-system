import type { AssetCandidateRow, AssetsRepository, FindCandidatesQuery } from '@tps/db';
import type { AssetRole } from '@tps/schemas';

/**
 * Fake 素材库（本地图片库）实现。
 *
 * 用于测试：模拟素材库的命中/未命中/延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **按角色编排**：`byRole` 允许为 Hero / 景点 / 美食分别配置不同的行为；
 * - **延迟模拟**：`delayMs` 模拟数据库查询慢（真实场景下可能是网络抖动或慢查询）；
 * - **故障模拟**：`error` 模拟数据库连接失败或查询超时；
 * - **命中/未命中**：`hit` 返回候选列表，`miss` 返回空列表。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/db/src/assets.ts`）会：
 * 1. 执行 pgvector 向量检索（`findCandidates`）；
 * 2. 执行精确键查询（`findByCacheKey`）；
 * 3. 过滤缺尺寸/缺 MIME 的行。
 *
 * Fake 实现**不执行**这些操作，只返回预置的候选列表。这保证了测试的确定性：
 * 不依赖数据库状态，不依赖向量模型，不依赖网络。
 */
export interface FakeLocalLibraryBehavior {
  /** 命中：返回候选列表 */
  readonly hit?: readonly AssetCandidateRow[];
  /** 未命中：返回空列表 */
  readonly miss?: boolean;
  /** 延迟毫秒数（模拟数据库查询慢） */
  readonly delayMs?: number;
  /** 故障：抛错（模拟数据库连接失败） */
  readonly error?: Error;
}

export interface FakeLocalLibraryOptions {
  /** 按槽位角色编排行为 */
  readonly byRole?: Partial<Record<AssetRole, FakeLocalLibraryBehavior>>;
  /** 按缓存键编排行为（用于 findByCacheKey） */
  readonly byCacheKey?: Record<string, FakeLocalLibraryBehavior>;
  /** 全局默认行为 */
  readonly default?: FakeLocalLibraryBehavior;
}

/**
 * 包装 `AssetsRepository`，按角色与缓存键注入编排行为。
 *
 * ## 关键设计：按 `entityName` 推断角色
 *
 * `findCandidates` 的查询条件里**没有** `role` 字段，只有 `entityName` /
 * `destinationPlaceId` / `destinationName`。因此这里用 `entityName`
 * 推断角色：
 *
 *   - Hero 槽位：`entityName` 为 null（Hero 没有实体名）
 *   - 景点/美食槽位：`entityName` 非空
 *
 * 这与 `resolve-assets.ts` 的 `cacheKeyFor` 的判据一致（Hero 的
 * `entityName` 为 null，景点/美食的 `entityName` 非空）。
 *
 * ## 缓存键的编排
 *
 * `findByCacheKey` 按 `byCacheKey` 编排：先匹配缓存键，再回退到真实实现。
 * 这允许测试模拟「缓存键命中」的场景（如占位图）。
 */
export function wrapLocalLibrary(
  repo: AssetsRepository,
  options: FakeLocalLibraryOptions,
): AssetsRepository {
  const behaviorFor = (role: AssetRole): FakeLocalLibraryBehavior => {
    return options.byRole?.[role] ?? options.default ?? {};
  };

  const behaviorForCacheKey = (cacheKey: string): FakeLocalLibraryBehavior => {
    // 按缓存键编排（用于 findByCacheKey）
    for (const [key, behavior] of Object.entries(options.byCacheKey ?? {})) {
      if (cacheKey === key) return behavior;
    }
    return {};
  };

  return {
    ...repo,
    findCandidates: async (query: FindCandidatesQuery) => {
      // 从 query 中推断角色（通过 entityName 是否为 null）
      const role = inferRoleFromQuery(query);
      const behavior = behaviorFor(role);

      if (behavior.error) {
        throw behavior.error;
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      if (behavior.hit !== undefined) {
        return behavior.hit;
      }

      if (behavior.miss === true) {
        return [];
      }

      // 默认：调用真实实现
      return repo.findCandidates(query);
    },
    findByCacheKey: async (cacheKey: string) => {
      const behavior = behaviorForCacheKey(cacheKey);

      if (behavior.error) {
        throw behavior.error;
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      if (behavior.hit !== undefined) {
        // 返回第一个候选（缓存键查询返回单行）
        return behavior.hit[0] ?? null;
      }

      if (behavior.miss === true) {
        return null;
      }

      // 默认：调用真实实现
      return repo.findByCacheKey(cacheKey);
    },
  };
}

/**
 * 判定一次库内检索对应的槽位角色。
 *
 * 生产路径经 `local-library.ts` 发起，query 里带着 `role`（精确）。
 * 直接单测本 wrapper 时可以不带，此时退化为按 `entityName` 是否为 null
 * 的启发式：Hero 没有实体名，景点/美食有 —— 后两者之间无法区分，
 * 需要区分它们的按角色编排请显式传 `role`。
 */
function inferRoleFromQuery(query: FindCandidatesQuery): AssetRole {
  if (query.role !== undefined) return query.role;

  // 通过 entityName 推断：Hero 没有 entityName，景点/美食有
  if (query.entityName === null || query.entityName === undefined) {
    return 'HERO_BACKGROUND';
  }

  // 通过 assetType 推断：目前只有 IMAGE，无法区分景点/美食
  // 这里简化处理：返回 DESTINATION_PHOTO
  return 'DESTINATION_PHOTO';
}

export { inferRoleFromQuery as _inferRoleFromQueryForTest };
