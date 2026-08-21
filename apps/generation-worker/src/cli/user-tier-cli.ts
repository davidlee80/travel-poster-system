import { createPool, createTierAdminRepository, loadDbConfig } from '@tps/db';
import type { UserTierRow } from '@tps/db';

/**
 * 用户分层等级的运维 CLI（多模型 failover 计划的任务 5，迁移 0009）。
 *
 * ```bash
 * pnpm user:tier -- --email a@b.com              # 查当前等级
 * pnpm user:tier -- --email a@b.com --set 10     # 设置等级
 * pnpm user:tier -- --list 10                    # 列出该档全部用户
 * ```
 *
 * 只需 `DATABASE_URL`。
 *
 * ## 为什么是 CLI 而不是端点
 *
 * 与 13.11 的 `content:find` 同一理由：改别人的等级天然是跨用户操作，
 * 公网暴露任何形态都与 13.0 的隔离原则相悖。而它的调用频率是
 * 「运营偶尔改一次」—— 一个端点要配的鉴权与审计比它本身贵得多。
 *
 * ## 为什么与 `model:pool` 放在同一个包
 *
 * `tier_level` 与候选池是同一个特性的两端：改等级的唯一目的就是换池，
 * 而运营的操作永远是「先设等级、再看映射」。两条命令分在两个包里的话，
 * 部署时会出现「能改等级但看不到它落在哪个池」这种半可用状态。
 *
 * ## 为什么不校验「这个等级有没有对应的映射」
 *
 * 区间匹配意味着 `tier_level = 15` 在没有 15 那一档时会落到 10
 * （见迁移 0009）。校验「必须存在同名档位」会把这个设计的收益作废 ——
 * 运营本来就该能先给用户升级、再决定要不要为这一档单独配池。
 */

export type UserTierCommand =
  | { readonly kind: 'show'; readonly email: string }
  | { readonly kind: 'set'; readonly email: string; readonly tierLevel: number }
  | { readonly kind: 'list'; readonly tierLevel: number; readonly limit: number };

/** 列表默认条数。运维查询是人在看，一屏之内（与 content:find 一致） */
export const DEFAULT_LIST_LIMIT = 20;

export function parseArgs(argv: readonly string[]): UserTierCommand {
  const values = parseFlags(argv);

  const email = values.get('email');
  const listRaw = values.get('list');
  const setRaw = values.get('set');

  if (email !== undefined && listRaw !== undefined) {
    // 两个动作各自要求不同的必填项，同时给必然有一个被忽略
    throw new Error('--email 与 --list 不能同时使用');
  }

  if (listRaw !== undefined) {
    return {
      kind: 'list',
      tierLevel: parseTier(listRaw, '--list'),
      limit: parseLimit(values.get('limit')),
    };
  }

  if (email === undefined) {
    throw new Error('需要 --email <邮箱> 或 --list <等级>');
  }

  if (setRaw === undefined) return { kind: 'show', email };
  return { kind: 'set', email, tierLevel: parseTier(setRaw, '--set') };
}

/**
 * `--flag value` 形态的解析，与 `content-cli.ts` 同一实现。
 *
 * 抄一份而不是提取到共享包：两个 CLI 各自只有这一处用它，而把 20 行
 * 参数解析变成一个跨包依赖，会让「改一个 CLI 的参数风格」变成
 * 「可能影响另一个 CLI」。真到第三个 CLI 时再提。
 */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // 裸 `--` 是 pnpm 的参数分隔符，会被原样透传进 argv
    if (token === undefined || token === '--' || !token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`选项 ${token} 缺少取值`);
    }
    values.set(token.slice(2), next);
    i += 1;
  }

  return values;
}

/**
 * 等级解析。
 *
 * 在这里拒掉负数与非整数，而不是等数据库的 `users_tier_level_check` 报错：
 * 那条约束的报文是 `violates check constraint "users_tier_level_check"`，
 * 对着终端的人得先去翻迁移文件才知道自己错在哪。
 */
function parseTier(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} 需要非负整数，收到：${raw}`);
  }
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit 取值非法：${raw}`);
  }
  return value;
}

export function formatUser(row: UserTierRow): string {
  return `tier ${String(row.tierLevel).padStart(3)}  ${row.email ?? '(匿名)'}  ${row.userId}  ${row.userType}`;
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const pool = createPool(loadDbConfig());
  const repository = createTierAdminRepository(pool);

  try {
    if (command.kind === 'list') {
      const rows = await repository.listUsersByTier(command.tierLevel, command.limit);
      if (rows.length === 0) {
        process.stdout.write(`tier_level = ${command.tierLevel} 没有 ACTIVE 用户。\n`);
        return;
      }
      process.stdout.write(`${rows.map(formatUser).join('\n')}\n`);
      if (rows.length === command.limit) {
        process.stdout.write(`\n（已达 --limit ${command.limit}，结果可能被截断）\n`);
      }
      return;
    }

    const row =
      command.kind === 'show'
        ? await repository.findUserByEmail(command.email)
        : await repository.setTierByEmail(command.email, command.tierLevel);

    if (row === null) {
      /*
       * 退出码非 0：这条命令常出现在运维脚本里（批量给一批邮箱设等级），
       * 静默成功会让「邮箱拼错了」变成「改完了但没生效」。
       */
      throw new Error(`没有邮箱为 ${command.email} 的 ACTIVE 注册用户`);
    }

    process.stdout.write(`${formatUser(row)}\n`);
  } finally {
    await pool.end();
  }
}

// 仅在被直接执行时跑 main，被测试 import 时不跑（与 content-cli 一致）
if (process.argv[1]?.includes('user-tier-cli') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`user:tier 失败：${String(error)}\n`);
    process.exitCode = 1;
  });
}
