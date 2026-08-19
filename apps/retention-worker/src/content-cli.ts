import { createContentFindRepository, createPool, loadDbConfig } from '@tps/db';
import type { ContentFindQuery, ContentFindRow } from '@tps/db';
import { contentPrefix } from '@tps/storage';

/**
 * 13.11 内部内容检索 CLI（TP-6-16，设计稿 13.11 / R-52）。
 *
 * ```bash
 * pnpm content:find -- --content-id 0192a3b4-c5d6-7890-8abc-def012345678
 * pnpm content:find -- --user <user_id> [--from 2026-08-01 --to 2026-09-01]
 * pnpm content:find -- --from 2026-08-01 --to 2026-09-01 [--status REJECTED]
 * ```
 *
 * 只需 `DATABASE_URL`。
 *
 * ## 为什么是 CLI 而不是端点
 *
 * 13.11：「检索维度天然含跨用户查询，公网暴露任何形态都与 13.0 的隔离原则
 * 相悖 —— 与 14.3 的处理一致，运维入口是 CLI。」
 *
 * ## 为什么放在 retention-worker
 *
 * 它要输出「存储前缀」，因此同时需要 `@tps/db` 与 `@tps/storage` 的键构造器。
 * retention-worker 在 TP-6-14 之后正好同时依赖两者，且用的是**同一段**
 * 「枚举内容 → 推导前缀」的逻辑。放进 `packages/db` 会把 AWS SDK 拖进
 * 迁移 CLI 的依赖树（`@tps/storage` 刻意不进那条链，见它的 index.ts）。
 *
 * ## 输出里为什么有 user_id
 *
 * 二十章禁止把 `user_id` 写进**日志与指标**，因为那会让身份进入长期留存的
 * 遥测数据。这个 CLI 是人在终端里主动执行的一次性查询，输出不落盘、
 * 不进日志管道 —— 而客服排查的第一件事恰恰是「这个内容属于谁」。
 */

export interface ContentCliArgs {
  readonly contentId: string | null;
  readonly userId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly status: string | null;
  readonly limit: number;
}

/** 默认条数。运维查询是人在看，一屏之内 */
export const DEFAULT_LIMIT = 20;

export function parseArgs(argv: readonly string[]): ContentCliArgs {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    /*
     * 裸 `--` 是 pnpm 的参数分隔符，会被原样透传进 argv
     * （`pnpm content:find -- --user x` 的 argv 里有它）。忽略它 ——
     * 不忽略的话它会被当成一个名为空串的选项，然后把下一个选项吞掉，
     * 表现是「选项 -- 缺少取值」这种让人完全查不到方向的错误。
     */
    if (token === undefined || token === '--' || !token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`选项 ${token} 缺少取值`);
    }
    values.set(token.slice(2), next);
    i += 1;
  }

  const limitRaw = values.get('limit');
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit 取值非法：${String(limitRaw)}`);
  }

  return {
    contentId: values.get('content-id') ?? null,
    userId: values.get('user') ?? null,
    from: parseDate(values.get('from'), '--from'),
    to: parseDate(values.get('to'), '--to'),
    status: values.get('status') ?? null,
    limit,
  };
}

/**
 * 日期解析。
 *
 * 只接受 `YYYY-MM-DD` 或完整 ISO 8601，且**按 UTC 解释** ——
 * `new Date('2026-08-01')` 已经是 UTC 午夜，但 `new Date('2026/08/01')`
 * 是本地时区。限定格式而不是接受一切 `Date` 能解析的东西：
 * 后者会让同一条命令在不同 TZ 的机器上查出不同的区间，
 * 而 15.4 的路径与 UUIDv7 的时间前缀都是 UTC。
 */
function parseDate(raw: string | undefined, flag: string): Date | null {
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) {
    throw new Error(`${flag} 需要 YYYY-MM-DD 或 ISO 8601 格式，收到：${raw}`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} 无法解析：${raw}`);
  }
  return parsed;
}

export function toQuery(args: ContentCliArgs): ContentFindQuery {
  return {
    ...(args.contentId === null ? {} : { contentId: args.contentId }),
    ...(args.userId === null ? {} : { userId: args.userId }),
    ...(args.from === null ? {} : { from: args.from }),
    ...(args.to === null ? {} : { to: args.to }),
    ...(args.status === null ? {} : { status: args.status }),
    limit: args.limit,
  };
}

/**
 * 一行结果的可读形式。
 *
 * 存储前缀由 15.4 的键构造器推导（TP-6-11）—— 与写入侧**同一个函数**，
 * 因此「运维看到的前缀」与「对象实际所在的前缀」不可能分叉。
 */
export function formatRow(row: ContentFindRow): string {
  const prefix = contentPrefix({
    userType: row.userType,
    userId: row.userId,
    contentId: row.contentId,
    contentCreatedAt: row.createdAt,
  });

  return [
    `content_id   ${row.contentId}`,
    `  归属       ${row.userId}（${row.userType}${row.userStatus === 'ACTIVE' ? '' : `/${row.userStatus}`}）`,
    `  计划       ${row.planId}`,
    `  状态       ${row.versionStatus}`,
    `  生成时刻   ${row.createdAt.toISOString()}`,
    `  目的地     ${row.destinationPlaceId ?? '-'}（${row.totalDays ?? '-'} 天）`,
    `  存储前缀   ${prefix}`,
    `  任务       ${row.jobIds.length === 0 ? '-' : row.jobIds.join(', ')}`,
    `  导出       ${row.exportIds.length === 0 ? '-' : row.exportIds.join(', ')}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadDbConfig();
  const pool = createPool(config);

  try {
    const rows = await createContentFindRepository(pool).find(toQuery(args));

    if (rows.length === 0) {
      process.stdout.write('没有匹配的内容。\n');
      return;
    }

    process.stdout.write(`${rows.map(formatRow).join('\n\n')}\n`);
    if (rows.length === args.limit) {
      // 恰好等于上限时提示可能被截断 —— 否则「只有 20 条」会被当成结论
      process.stdout.write(`\n（已达 --limit ${args.limit}，结果可能被截断）\n`);
    }
  } finally {
    await pool.end();
  }
}

/*
 * 仅在被直接执行时跑 main，被测试 import 时不跑。
 * 与 ingest-cli / preheat-cli 同一处理。
 */
if (process.argv[1]?.includes('content-cli') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`content:find 失败：${String(error)}\n`);
    process.exitCode = 1;
  });
}
