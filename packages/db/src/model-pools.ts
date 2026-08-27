import type { Pool } from 'pg';

/**
 * 模型候选池的查询（迁移 0009，多模型 failover 计划的任务 2）。
 *
 * ## 区间匹配
 *
 * 给定用户的 `tier_level`，取 `min_tier_level <= level` 中**最大**的那条映射。
 * 因此运营新增 tier_level = 15 的用户时不需要加映射 —— 它自动落到 10 那一档。
 * 这是选整数等级而非枚举的收益（见迁移 0009 的文件头）。
 *
 * ## 两张表为空时返回 null，调用方回落 env
 *
 * `null` 的语义是「**没有配置**」，与「配了一个空池」严格区分（后者被数据库的
 * 非空数组约束禁止）。调用方收到 null 时回落到 `LLM_MODEL` / `IMAGE_MODEL`
 * 的单模型行为，也就是迁移完不配置任何池时系统行为与现在完全一致。
 *
 * ## 为什么带进程内缓存
 *
 * 不是为了一个任务内的重复读。按 3.7.4，候选链是**每任务装配一次**的（
 * `deps.llm(...)` 与 `deps.aiAssets(...)` 各调一次），因此一个任务最多只读两次
 * —— LLM 一次、IMAGE 一次。
 *
 * 缓存真正省的是**跳任务**的重复查询：一个 Worker 进程持续消费队列，
 * 而这份配置变化的频率是「运营偶尔调一次」。没有它的话，每个任务开头
 * 都要为一份几乎不变的配置多两次网络往返，而它们落在 T1 的关键路径上。
 *
 * （这段原本写的是「一次生成任务里会被读若干次（图像每个槽位一次）」——
 * 那是改成每任务工厂之前的形态。结论不变（仍该缓存），但理由变了：
 * 按旧理由读，会以为掉了缓存会打穿 10.2 的 800 毫秒单槽位预算，
 * 而实际上单槽位路径上压根没有这次查询。）
 *
 * TTL 而不是失效通知：后者需要 pub/sub，而配置类数据滞后一分钟没有实质影响。
 * 代价是运营改完要等最多 TTL 才生效，这一点写进运维手册。
 */

export type ModelPoolKind = 'LLM' | 'IMAGE';

export interface ModelPoolSelection {
  readonly poolName: string;
  /** 有序候选，顺序即 failover 尝试顺序 */
  readonly models: readonly string[];
  /** 该档的候选数上限。null = 用满整个池 */
  readonly maxCandidates: number | null;
  /** 命中的映射档位，供日志与 CLI 输出 */
  readonly minTierLevel: number;
}

export interface ModelPoolsRepository {
  /** 按 kind 与用户等级选出候选池。无配置时返回 null */
  select(kind: ModelPoolKind, tierLevel: number): Promise<ModelPoolSelection | null>;
  /** 丢弃缓存。CLI 写入后调用，让本进程立刻看到新值 */
  invalidate(): void;
}

/** 默认缓存存活时间 */
export const DEFAULT_POOL_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly value: ModelPoolSelection | null;
  readonly expiresAt: number;
}

export interface ModelPoolsRepositoryOptions {
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export function createModelPoolsRepository(
  pool: Pool,
  options: ModelPoolsRepositoryOptions = {},
): ModelPoolsRepository {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_POOL_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  return {
    async select(kind, tierLevel) {
      const key = `${kind}:${tierLevel}`;
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now()) return cached.value;

      const result = await pool.query<{
        pool_name: string;
        models: unknown;
        max_candidates: number | null;
        min_tier_level: number;
      }>(
        `SELECT t.pool_name, p.models, t.max_candidates, t.min_tier_level
           FROM tier_model_pools t
           JOIN model_pools p ON p.name = t.pool_name AND p.kind = t.kind
          WHERE t.kind = $1 AND t.min_tier_level <= $2
          ORDER BY t.min_tier_level DESC
          LIMIT 1`,
        [kind, tierLevel],
      );

      const row = result.rows[0];
      const value: ModelPoolSelection | null =
        row === undefined
          ? null
          : {
              poolName: row.pool_name,
              /*
               * JSONB 数组回来是 unknown。这里只过滤出字符串而不抛错：
               * 数据库的 CHECK 保证了「是非空数组」，但保证不了「每一项都是
               * 字符串」—— 而一个混进数字的模型名不该让整个生成任务失败，
               * 它应该表现为「那个候选不可用」。
               */
              models: Array.isArray(row.models)
                ? row.models.filter((item): item is string => typeof item === 'string')
                : [],
              maxCandidates: row.max_candidates,
              minTierLevel: row.min_tier_level,
            };

      cache.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    },

    invalidate() {
      cache.clear();
    },
  };
}

/**
 * 把「池 + 该档上限 + 时延预算」算成实际要用的候选序列。
 *
 * ## 为什么截断而不是拒绝
 *
 * 候选数来自数据库，运营可以在系统运行时把它改成 10 —— 而
 * `10 × 40 秒 = 400 秒` 会突破 300 秒的任务上限。启动即校验（`loadImageConfig`
 * 那一套）对数据库配置不成立，防线只能设在读取处。
 *
 * 拒绝服务会让一次配置失误变成用户拿不到计划；截断只是少试几个候选。
 * 但**必须可见** —— 静默截断会让运营以为配置生效了，因此返回 `clamped`
 * 供调用方记日志与指标（`travel_ai_pool_clamped_total`）。
 */
export function resolveCandidates(input: {
  readonly models: readonly string[];
  readonly maxCandidates: number | null;
  /** 单候选超时 */
  readonly perAttemptMs: number;
  /** 整条链允许的总时长 */
  readonly totalBudgetMs: number;
}): { readonly candidates: readonly string[]; readonly clamped: boolean } {
  const byConfig =
    input.maxCandidates === null
      ? input.models.length
      : Math.min(input.maxCandidates, input.models.length);

  /*
   * 时延允许的候选数。至少给 1 —— 预算比单次超时还小时仍然试一个，
   * 那比一张图都不生成好，而且这种配置本身会被启动校验挡住
   * （IMAGE_TIMEOUT_MS 必须 ≤ IMAGE_JOB_AI_BUDGET_MS）。
   */
  const byBudget = Math.max(1, Math.floor(input.totalBudgetMs / Math.max(1, input.perAttemptMs)));

  const count = Math.min(byConfig, byBudget);
  return { candidates: input.models.slice(0, count), clamped: count < byConfig };
}
