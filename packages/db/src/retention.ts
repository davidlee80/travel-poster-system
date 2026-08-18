import type { Pool, PoolClient } from 'pg';

/**
 * 保留期清理与知识转存（TP-4-21/22，设计稿 15.1）。
 *
 * ```text
 * 每日扫描到期匿名 users 行（anon_expires_at 到期后 30 天宽限）
 *   → 把其 travel_plan_versions 的 retrieval_projection + plan_embedding
 *     转存到 plan_knowledge（无 user_id、无任何标识符）
 *   → 再级联删除 users 行
 * ```
 *
 * ## 顺序不可颠倒，而且必须在同一个事务里
 *
 * 15.1 的原文是「清理匿名 users 行**之前**：把知识转存……然后再级联删除」。
 * 先删后转存会永久损失行程知识（3.2.4 的全局检索会持续失血，而匿名请求
 * 占比可能很高）。
 *
 * 但「顺序对」还不够 —— 两步必须在**同一个事务**里：分两个事务的话，
 * 转存成功、删除失败会留下一份重复的知识（下一轮再转存一次），
 * 而转存失败、删除成功则永久丢失。同一事务让两者要么都发生要么都不发生。
 *
 * ## plan_knowledge 里不能有任何标识符
 *
 * 门禁 #29。这里靠 INSERT 的列清单强制：只有
 * `destination_place_id / total_days / projection / embedding / source_status`
 * 五列，而 `projection` 就是 3.2.4 的脱敏投影（15.2 已经保证它不含 L1/L2）。
 * 表本身也没有 `user_id` 列（迁移 0003），因此这一条在数据库层同样成立。
 */

export interface ExpiredAnonymousUser {
  readonly userId: string;
  readonly anonExpiresAt: Date;
}

export interface PurgeUserResult {
  readonly userId: string;
  /** 转存到 `plan_knowledge` 的行数 */
  readonly transferred: number;
  readonly deleted: boolean;
}

export interface RetentionRepository {
  /**
   * 到期且过了宽限期的匿名用户，按到期时间升序（最旧的先清）。
   *
   * `ACTIVE` 与 `SUSPENDED` 都收：`MERGED` 的行已经把数据交给注册账号了
   * （13.9.4），它的 `anon_expires_at` 仍在但不该按匿名数据清理 ——
   * 那些计划现在属于一个注册用户。
   */
  findExpiredAnonymous(input: {
    readonly limit: number;
    readonly graceDays: number;
    readonly now?: Date;
  }): Promise<readonly ExpiredAnonymousUser[]>;

  /** 转存知识 + 级联删除，同一事务（15.1、TP-4-22） */
  purgeUser(userId: string): Promise<PurgeUserResult>;

  /** `travel_knowledge_rows` 指标的数据源（21.3） */
  countKnowledgeRows(): Promise<number>;
}

export function createRetentionRepository(pool: Pool): RetentionRepository {
  return {
    async findExpiredAnonymous({ limit, graceDays, now }) {
      const { rows } = await pool.query<{ id: string; anon_expires_at: Date }>(
        /*
         * 走 `users_anon_expiry_idx`（15.1 点名要求）。谓词写成
         * `anon_expires_at < $1 - interval` 而不是对列做运算 ——
         * 对列做运算会让索引失效，而这张表上匿名行占绝大多数。
         */
        `SELECT id, anon_expires_at
           FROM users
          WHERE user_type = 'ANONYMOUS'
            AND status IN ('ACTIVE', 'SUSPENDED')
            AND anon_expires_at IS NOT NULL
            AND anon_expires_at < ($1::timestamptz - ($2::int * interval '1 day'))
          ORDER BY anon_expires_at
          LIMIT $3`,
        [now ?? new Date(), graceDays, limit],
      );

      return rows.map((row) => ({ userId: row.id, anonExpiresAt: row.anon_expires_at }));
    },

    async purgeUser(userId) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        /*
         * 只转存**通过校验**的版本，且必须有向量。
         *   - REJECTED 的内容违反业务规则，让它参与检索等于把错误的安排
         *     推荐给后来的用户（`plan_knowledge_source_status_check` 也拦住它）；
         *   - `plan_embedding IS NULL` 的版本无法参与向量检索，而
         *     `plan_knowledge.embedding` 是 NOT NULL。
         */
        const transferred = await client.query(
          `INSERT INTO plan_knowledge
             (destination_place_id, total_days, projection, embedding, source_status)
           SELECT v.destination_place_id, v.total_days, v.retrieval_projection,
                  v.plan_embedding, v.status
             FROM travel_plan_versions v
             JOIN travel_plans p ON p.id = v.plan_id
            WHERE p.user_id = $1
              AND v.status IN ('READY', 'REPAIRED')
              AND v.plan_embedding IS NOT NULL
              AND v.destination_place_id IS NOT NULL`,
          [userId],
        );

        /*
         * 级联删除：`travel_requests` / `travel_plans` / `travel_plan_versions`
         * / `generation_jobs` / `exports` 都是 ON DELETE CASCADE（迁移 0003），
         * `plan_presentations` / `plan_asset_bindings` 随版本级联（0005）。
         * `assets` 不删（15.1 明确「不删除」）—— 素材是跨用户共享的。
         */
        const deleted = await client.query('DELETE FROM users WHERE id = $1', [userId]);

        await client.query('COMMIT');
        return {
          userId,
          transferred: transferred.rowCount ?? 0,
          deleted: (deleted.rowCount ?? 0) > 0,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async countKnowledgeRows() {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM plan_knowledge',
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}
