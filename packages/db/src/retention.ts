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

  /**
   * 该用户名下全部导出产物的**真实**对象键（TP-6-14）。
   *
   * 读 `exports.files[].storage_key` —— 那是 `FinishExportInput.files` 落库时
   * 写进去的、真的被 `put` 用过的键。
   *
   * **这是对设计稿的一处偏离（R-53）**：15.1 / R-51 写的是「按其名下
   * `content_id` 枚举并删除对象（由 15.4 键构造器推导对象键）」。推导法只能
   * 覆盖 15.4 的新布局，而实施计划第七章明确存量旧键布局
   * （`exports/{export_id}/`）**不迁移** —— 于是那些对象永远删不掉，
   * 成为永久孤儿。读 `storage_key` 同时覆盖两种布局，且它仍严格是
   * 「以数据库归属为准、不按前缀」（R-50），比推导更强。
   *
   * 键构造器仍然交付（TP-6-11），用于**写入侧**与 `content:find` 的前缀展示。
   */
  listExportObjectKeys(userId: string): Promise<readonly string[]>;
  /**
   * 转存知识 + 级联删除，同一事务（15.1、TP-4-22）。
   *
   * `beforeDelete` 在同一事务内、`DELETE FROM users` **之前**执行
   * （TP-6-14）。抛错则整体回滚且行保留 —— 顺序不能反过来：
   * 行先删则 `files[].storage_key` 随之消失，产物成为永久孤儿。
   */
  purgeUser(userId: string, beforeDelete?: () => Promise<void>): Promise<PurgeUserResult>;

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

    async listExportObjectKeys(userId) {
      /*
       * `jsonb_array_elements` 展开 `files`，取每个产物的 `storage_key`。
       *
       * `files` 可以是空数组（FAILED 的导出没上传过任何对象），
       * 因此用 `jsonb_array_elements` 而不是 `->0->>'storage_key'` ——
       * 后者只取第一个，而 `ALL_DAYS` + PNG 会有 14 个。
       *
       * 过滤 NULL 与空串：P4 之前的行可能没有这个字段
       * （`ExportArtifactSchema` 后来才要求它必填），而把空串当键传给
       * DeleteObjects 会让整批请求被 S3 拒绝。
       */
      const { rows } = await pool.query<{ storage_key: string }>(
        `SELECT DISTINCT f->>'storage_key' AS storage_key
           FROM exports e
           CROSS JOIN LATERAL jsonb_array_elements(e.files) AS f
          WHERE e.user_id = $1
            AND f->>'storage_key' IS NOT NULL
            AND f->>'storage_key' <> ''`,
        [userId],
      );
      return rows.map((row) => row.storage_key);
    },

    async purgeUser(userId, beforeDelete) {
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
         * 对象存储的清理在**删行之前**（TP-6-14、15.1 / R-51）。
         *
         * 顺序不能反：行先删则 `exports.files[].storage_key` 随之消失，
         * 而那是唯一能推出对象键的地方 —— 产物成为永久孤儿，
         * 且因为 `anon/` 前缀禁挂生命周期规则（R-50），它们永远不会过期。
         *
         * 放在事务内：抛错则整体回滚、行保留、下一轮重试。
         * 放在事务外（先删对象再开事务）的话，删对象成功而转存失败时
         * 会得到「产物没了但行还在」—— 用户看到一个指向 404 的下载链接。
         */
        if (beforeDelete !== undefined) await beforeDelete();

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
