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
 * ## 为什么有 delete：它是被承诺的回滚路径
 *
 * 迁移 0009 的文件头写着「回滚也不需要动代码 —— 清空 `tier_model_pools`
 * 即可」。那句话描述的是**故障时最需要的那个操作**：池配错导致大面积
 * failover 时，把映射删掉就回落到 env 单模型。而它一度没有任何实现，
 * 运营只能拿 psql 连生产库 —— 半夜、有压力、手写 DELETE，正是最容易
 * 打错 WHERE 的场合。
 *
 * 两者的安全性不同，因此接口形状也不同：
 *
 *   - `deleteMapping` 天然安全 —— 删掉即回落 env，没有任何东西引用映射。
 *   - `deletePool` 会撞外键。**先查引用并如实返回**，而不是让
 *     `violates foreign key constraint` 冒到运营面前 —— 那句话不回答
 *     「哪几档还指着它」，而那正是下一步要做的事。
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
  /**
   * 三态：**属性缺省** = 保留原备注，`null` = 显式清空，字符串 = 设置。
   *
   * 「缺省 = 保留」而不是「缺省 = 清空」：改模型顺序是应急操作（见运维手册
   * 「主模型胜出率下降」一节），而应急时没人会先把「这一档只放便宜模型」
   * 那句备注抄下来。`exactOptionalPropertyTypes` 让这三态在类型层就能区分。
   */
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

  /**
   * 删一条 tier → 池的映射。这一档随后回落到 env 单模型。
   *
   * 返回 false 表示本来就没有这条映射 —— 调用方据此区分「删掉了」与
   * 「档位打错了」，后者在回滚场合下必须让人看见。
   */
  deleteMapping(kind: ModelPoolKind, minTierLevel: number): Promise<boolean>;

  /**
   * 删一个池。仍被映射引用时**不删**，并返回引用它的档位。
   *
   * 不靠外键报错：`violates foreign key constraint` 不回答「哪几档还指着
   * 它」，而那是下一步要做的事（先 `deleteMapping` 那几档）。
   */
  deletePool(
    name: string,
    kind: ModelPoolKind,
  ): Promise<{ readonly deleted: boolean; readonly referencedBy: readonly number[] }>;
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
         DO UPDATE SET models = EXCLUDED.models,
                       note = CASE WHEN $5::boolean THEN EXCLUDED.note ELSE model_pools.note END,
                       updated_at = NOW()`,
        [
          input.name,
          input.kind,
          JSON.stringify(input.models),
          input.note ?? null,
          /*
           * 「本次是否动备注」得单独传。光靠 `$4` 区分不了「不传」与「传 null」：
           * `COALESCE(EXCLUDED.note, model_pools.note)` 能保留，但那样就永远无法
           * 显式清空一条已经过时的备注了。
           */
          input.note !== undefined,
        ],
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

    async deleteMapping(kind, minTierLevel) {
      const result = await pool.query(
        `DELETE FROM tier_model_pools WHERE kind = $1 AND min_tier_level = $2`,
        [kind, minTierLevel],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deletePool(name, kind) {
      /*
       * 先查引用。并发插入一条映射会让下面的 DELETE 撞外键并抛错 ——
       * 那是可以接受的：这是运维 CLI，两个人同时改同一个池的概率可忽略，
       * 而外键在那种情况下正是我们要的最后防线。
       */
      const { rows } = await pool.query<{ min_tier_level: number }>(
        `SELECT min_tier_level FROM tier_model_pools
          WHERE pool_name = $1 AND kind = $2
          ORDER BY min_tier_level`,
        [name, kind],
      );

      if (rows.length > 0) {
        return { deleted: false, referencedBy: rows.map((row) => Number(row.min_tier_level)) };
      }

      const result = await pool.query(`DELETE FROM model_pools WHERE name = $1 AND kind = $2`, [
        name,
        kind,
      ]);
      return { deleted: (result.rowCount ?? 0) > 0, referencedBy: [] };
    },
  };
}
