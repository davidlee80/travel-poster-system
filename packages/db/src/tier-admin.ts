import type { Pool } from 'pg';

import type { ModelPoolKind } from './model-pools.js';

/**
 * 用户分层与模型候选池的**写侧**（迁移 0009，两个管理 CLI 的数据层）。
 *
 * ## 为什么与 `ModelPoolsRepository` 分开
 *
 * 那个接口在生成任务的热路径上，每个槽位都可能调它 —— 它只该有
 * `select` 与 `invalidate`。把「列出所有池」「改映射」塞进去，会让 Worker
 * 的类型面上出现一堆它永远不该调的写方法，而下一个人分不清哪些是安全的。
 *
 * ## 为什么用户分层的写也在这里
 *
 * `tier_level` 与两张池表是同一个特性的两端：改等级的唯一目的就是换池。
 * 放进 `UsersRepository` 会让认证路径的接口长出一个运维方法 ——
 * 而那个接口是被 API 的每次请求碰到的。
 *
 * ## 没有 delete
 *
 * 本轮的运维操作只有「查、设、映射」。删池需要先解开外键引用，
 * 而那个顺序一旦做错就是「某一档用户突然拿不到配置」——
 * 真需要时用 psql 做，比给 CLI 加一个半对的删除更安全。
 */

export interface UserTierRow {
  readonly userId: string;
  readonly email: string | null;
  readonly userType: string;
  readonly tierLevel: number;
}

export interface ModelPoolRow {
  readonly name: string;
  readonly kind: ModelPoolKind;
  readonly models: readonly string[];
  readonly note: string | null;
}

export interface TierMappingRow {
  readonly kind: ModelPoolKind;
  readonly minTierLevel: number;
  readonly poolName: string;
  readonly maxCandidates: number | null;
}

export interface UpsertPoolInput {
  readonly name: string;
  readonly kind: ModelPoolKind;
  readonly models: readonly string[];
  readonly note?: string | null;
}

export interface UpsertMappingInput {
  readonly kind: ModelPoolKind;
  readonly minTierLevel: number;
  readonly poolName: string;
  readonly maxCandidates: number | null;
}

export interface TierAdminRepository {
  /** 按邮箱查等级。返回 null 表示没有这个 ACTIVE 的注册用户 */
  findUserByEmail(email: string): Promise<UserTierRow | null>;
  /** 设置等级。返回 null 表示邮箱不存在（调用方据此给非 0 退出码） */
  setTierByEmail(email: string, tierLevel: number): Promise<UserTierRow | null>;
  /** 列出某一档的用户 */
  listUsersByTier(tierLevel: number, limit: number): Promise<readonly UserTierRow[]>;

  listPools(): Promise<readonly ModelPoolRow[]>;
  listMappings(): Promise<readonly TierMappingRow[]>;
  upsertPool(input: UpsertPoolInput): Promise<void>;
  upsertMapping(input: UpsertMappingInput): Promise<void>;
}

/** 一行 users 的投影 */
const USER_TIER_COLUMNS = 'id, email, user_type, tier_level';

interface UserTierDbRow {
  id: string;
  email: string | null;
  user_type: string;
  tier_level: number;
}

function toUserTier(row: UserTierDbRow): UserTierRow {
  return {
    userId: row.id,
    email: row.email,
    userType: row.user_type,
    tierLevel: Number(row.tier_level),
  };
}

export function createTierAdminRepository(pool: Pool): TierAdminRepository {
  return {
    async findUserByEmail(email) {
      const { rows } = await pool.query<UserTierDbRow>(
        `SELECT ${USER_TIER_COLUMNS} FROM users
          WHERE email = $1 AND status = 'ACTIVE'`,
        [email],
      );
      const row = rows[0];
      return row === undefined ? null : toUserTier(row);
    },

    async setTierByEmail(email, tierLevel) {
      const { rows } = await pool.query<UserTierDbRow>(
        `UPDATE users SET tier_level = $2, updated_at = NOW()
          WHERE email = $1 AND status = 'ACTIVE'
        RETURNING ${USER_TIER_COLUMNS}`,
        [email, tierLevel],
      );
      const row = rows[0];
      return row === undefined ? null : toUserTier(row);
    },

    async listUsersByTier(tierLevel, limit) {
      const { rows } = await pool.query<UserTierDbRow>(
        `SELECT ${USER_TIER_COLUMNS} FROM users
          WHERE tier_level = $1 AND status = 'ACTIVE'
          ORDER BY created_at DESC
          LIMIT $2`,
        [tierLevel, limit],
      );
      return rows.map(toUserTier);
    },

    async listPools() {
      const { rows } = await pool.query<{
        name: string;
        kind: string;
        models: unknown;
        note: string | null;
      }>(`SELECT name, kind, models, note FROM model_pools ORDER BY kind, name`);

      return rows.map((row) => ({
        name: row.name,
        kind: row.kind as ModelPoolKind,
        /*
         * 与 `ModelPoolsRepository.select` 同一处理：只保留字符串项。
         * 数据库的 CHECK 保证「是非空数组」但保证不了「每项都是字符串」，
         * 而 `--list` 的用途正是让运营看出配错了什么。
         */
        models: Array.isArray(row.models)
          ? row.models.filter((item): item is string => typeof item === 'string')
          : [],
        note: row.note,
      }));
    },

    async listMappings() {
      const { rows } = await pool.query<{
        kind: string;
        min_tier_level: number;
        pool_name: string;
        max_candidates: number | null;
      }>(
        `SELECT kind, min_tier_level, pool_name, max_candidates
           FROM tier_model_pools
          ORDER BY kind, min_tier_level`,
      );

      return rows.map((row) => ({
        kind: row.kind as ModelPoolKind,
        minTierLevel: Number(row.min_tier_level),
        poolName: row.pool_name,
        maxCandidates: row.max_candidates === null ? null : Number(row.max_candidates),
      }));
    },

    async upsertPool(input) {
      /*
       * `gen_random_uuid()` 而不是应用侧生成：只有插入分支需要 ID，
       * 而在应用侧生成会让每次「只是改模型列表」的更新都白造一个 UUID ——
       * 那个值不会被用上，但会出现在日志里让人以为建了新池。
       */
      await pool.query(
        `INSERT INTO model_pools (pool_id, name, kind, models, note)
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4)
         ON CONFLICT (name, kind)
         DO UPDATE SET models = EXCLUDED.models, note = EXCLUDED.note, updated_at = NOW()`,
        [input.name, input.kind, JSON.stringify(input.models), input.note ?? null],
      );
    },

    async upsertMapping(input) {
      await pool.query(
        `INSERT INTO tier_model_pools (kind, min_tier_level, pool_name, max_candidates)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, min_tier_level)
         DO UPDATE SET pool_name = EXCLUDED.pool_name,
                       max_candidates = EXCLUDED.max_candidates,
                       updated_at = NOW()`,
        [input.kind, input.minTierLevel, input.poolName, input.maxCandidates],
      );
    },
  };
}
