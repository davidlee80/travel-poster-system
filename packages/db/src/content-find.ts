import type { Pool } from 'pg';

import { uuidv7Boundary } from '@tps/shared';

/**
 * 13.11 内部内容检索（TP-6-16，设计稿 13.11 / R-52）。
 *
 * 需求清单 FR-6.6.5 要求按「内容 ID」「`user_id`」「生成时间范围」及其组合
 * 做内部检索（运维、客服、排查场景）。
 *
 * ## 为什么不是公网端点
 *
 * 13.11：检索维度天然含跨用户查询，公网暴露任何形态都与 13.0 的隔离原则
 * 相悖。与 14.3 的处理一致 —— 运维入口是 CLI。
 *
 * ## 时间范围走主键，不加新索引
 *
 * 13.11：「时间范围直接在 UUIDv7 主键上做范围扫描（构造边界 UUID，R-48）」。
 * PostgreSQL 的 `uuid` 按字节比较，与十六进制字典序一致，因此
 * `id BETWEEN min AND max` 就是「这段时间内生成的全部内容」。
 *
 * **存量 v4 行的兜底**：那些行的「时间前缀」是随机数据，落在 UUIDv7 的
 * 时间区间外（或误落在别的区间里）。因此谓词是两支的 OR：
 *
 * ```sql
 * (v.id >= $min AND v.id <= $max)                          -- 走主键索引
 * OR (substring(v.id::text, 15, 1) <> '7' AND v.created_at BETWEEN ...)
 * ```
 *
 * 第二支只扫存量 v4 行（生产为 0 行，`substring(...) <> '7'` 让 planner
 * 无法用索引，但那部分数据量恒定且不增长）。写成两支而不是「一律用
 * `created_at`」是 13.11 明确要求的 —— 前者在数据增长后仍是索引扫描。
 *
 * 版本半字节是 `id::text` 的第 15 个字符：`0192a3b4-c5d6-7890-...` 里
 * 两个连字符占掉 2 位，因此 `substring(x, 15, 1)` 取的是 `7` 那一位。
 */

export interface ContentFindQuery {
  /** 精确匹配 `travel_plan_versions.id`（= `content_id`） */
  readonly contentId?: string;
  readonly userId?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** `travel_plan_versions.status`（READY / REPAIRED / REJECTED） */
  readonly status?: string;
  readonly limit: number;
}

export interface ContentFindRow {
  readonly contentId: string;
  readonly planId: string;
  readonly userId: string;
  readonly userType: 'ANONYMOUS' | 'REGISTERED';
  readonly userStatus: string;
  readonly versionStatus: string;
  readonly createdAt: Date;
  readonly destinationPlaceId: string | null;
  readonly totalDays: number | null;
  readonly jobIds: readonly string[];
  readonly exportIds: readonly string[];
}

export interface ContentFindRepository {
  find(query: ContentFindQuery): Promise<readonly ContentFindRow[]>;
}

interface SqlRow {
  content_id: string;
  plan_id: string;
  user_id: string;
  user_type: string;
  user_status: string;
  version_status: string;
  created_at: Date;
  destination_place_id: string | null;
  total_days: number | null;
  job_ids: string[] | null;
  export_ids: string[] | null;
}

export function createContentFindRepository(pool: Pool): ContentFindRepository {
  return {
    async find(query) {
      /*
       * 至少要有一个筛选维度。全表扫描在这个表上是危险的（版本行是系统里
       * 最多的一类业务行），而一个不带任何条件的运维命令通常是打错了。
       */
      if (
        query.contentId === undefined &&
        query.userId === undefined &&
        query.from === undefined &&
        query.to === undefined
      ) {
        throw new Error('content:find 至少需要 --content-id / --user / --from 之一');
      }

      const from = query.from ?? null;
      const to = query.to ?? null;

      const { rows } = await pool.query<SqlRow>(
        `SELECT v.id                       AS content_id,
                v.plan_id,
                p.user_id,
                u.user_type,
                u.status                   AS user_status,
                v.status                   AS version_status,
                v.created_at,
                v.destination_place_id,
                v.total_days,
                (SELECT array_agg(j.id ORDER BY j.created_at)
                   FROM generation_jobs j
                  WHERE j.plan_version_id = v.id) AS job_ids,
                (SELECT array_agg(e.id ORDER BY e.created_at)
                   FROM exports e
                  WHERE e.plan_version_id = v.id) AS export_ids
           FROM travel_plan_versions v
           JOIN travel_plans p ON p.id = v.plan_id
           JOIN users u ON u.id = p.user_id
          WHERE ($1::uuid IS NULL OR v.id = $1::uuid)
            AND ($2::uuid IS NULL OR p.user_id = $2::uuid)
            AND ($5::text IS NULL OR v.status = $5::text)
            AND (
              -- 无时间范围时这一整块不参与筛选
              ($3::timestamptz IS NULL AND $4::timestamptz IS NULL)
              -- 主路径：UUIDv7 主键范围扫描（13.11 明确要求）
              OR (
                ($3::timestamptz IS NULL OR v.id >= $6::uuid)
                AND ($4::timestamptz IS NULL OR v.id <= $7::uuid)
              )
              -- 兜底：存量 v4 行的时间前缀是随机数据，只能看 created_at
              OR (
                substring(v.id::text, 15, 1) <> '7'
                AND ($3::timestamptz IS NULL OR v.created_at >= $3::timestamptz)
                AND ($4::timestamptz IS NULL OR v.created_at < $4::timestamptz)
              )
            )
          ORDER BY v.id DESC
          LIMIT $8`,
        [
          query.contentId ?? null,
          query.userId ?? null,
          from,
          to,
          query.status ?? null,
          from === null ? null : uuidv7Boundary(from, 'min'),
          to === null ? null : uuidv7Boundary(to, 'max'),
          query.limit,
        ],
      );

      return rows.map((row) => ({
        contentId: row.content_id,
        planId: row.plan_id,
        userId: row.user_id,
        userType: row.user_type === 'REGISTERED' ? 'REGISTERED' : 'ANONYMOUS',
        userStatus: row.user_status,
        versionStatus: row.version_status,
        createdAt: row.created_at,
        destinationPlaceId: row.destination_place_id,
        totalDays: row.total_days,
        jobIds: row.job_ids ?? [],
        exportIds: row.export_ids ?? [],
      }));
    },
  };
}
