import { randomUUID } from 'node:crypto';

import { creditsToCnyText, loadCreditConfig } from '@tps/billing';
import {
  createCreditWalletRepository,
  createPool,
  createUsersRepository,
  loadDbConfig,
  type LedgerEntry,
} from '@tps/db';

/**
 * CR 钱包的运维 CLI（C-5，迁移 0013）。
 *
 * ```bash
 * pnpm user:credit -- --email a@b.com                     # 查余额与最近流水
 * pnpm user:credit -- --phone 13800000000                 # 同上，按手机号
 * pnpm user:credit -- --email a@b.com --grant 9900        # 授予 9900 CR
 * pnpm user:credit -- --email a@b.com --grant 9900 --note "工单 123 的补偿"
 * ```
 *
 * 只需 `DATABASE_URL`。**与 `CREDIT_BILLING_ENABLED` 无关** ——
 * 那个开关管的是「生成要不要扣费」，而在打开它之前恰恰需要先用这条命令
 * 给存量用户授一笔（否则开关一开谁都生成不了）。
 *
 * ## 为什么支持 --phone
 *
 * P7 之后手机号是主要注册路径，而那些用户**没有邮箱**
 * （`users_registered_shape` 在 0010 放宽成「邮箱或已验证手机号」）。
 * 只按邮箱查的话，运维对新注册的用户全都查不到，
 * 而症状是「这个用户不存在」—— 一句会让人去查数据丢失的错话。
 *
 * ## 为什么授予只收 CR，不收元
 *
 * 两个单位都收的话，`--grant 9.9` 与 `--grant 9900` 长得同样合理，
 * 而两者差 1000 倍。系统内部只认 CR，因此入参只认 CR ——
 * 元只在输出里作为参考出现。
 *
 * ## 为什么有个上限
 *
 * `--grant 9900000` 与 `--grant 9900` 差一个手滑，而多授出去的钱**没有
 * 撤销入口**（流水是只追加的账，冲销要写一条反向 `ADJUST`，
 * 而 `credit()` 只接受正数）。因此默认拦住 1000 元以上的授予，
 * 真要授大额加 `--force`。这比补一条带符号的冲销通道便宜得多，
 * 而它防住的正是那个手滑。
 */

/** 默认展示的流水条数。运维查询是人在看，一屏之内（与 user:tier 一致） */
export const DEFAULT_HISTORY_LIMIT = 10;

/**
 * 不带 `--force` 时允许的单次授予上限（CR）。
 *
 * 1000 元。按占位价一次 5 天行程约 3 元，因此这个上限相当于「几百次生成」——
 * 任何正常的补偿都在它之下，而超过它的数几乎只可能是手滑。
 */
export const MAX_GRANT_CR = 1_000_000;

export type UserCreditCommand =
  | { readonly kind: 'show'; readonly lookup: UserLookup; readonly limit: number }
  | {
      readonly kind: 'grant';
      readonly lookup: UserLookup;
      readonly amountCr: number;
      readonly note: string | null;
      readonly limit: number;
    };

export type UserLookup =
  | { readonly by: 'email'; readonly value: string }
  | { readonly by: 'phone'; readonly value: string };

export function parseArgs(argv: readonly string[]): UserCreditCommand {
  const values = parseFlags(argv);

  const email = values.get('email');
  const phone = values.get('phone');
  if (email !== undefined && phone !== undefined) {
    throw new Error('--email 与 --phone 不能同时使用');
  }

  let lookup: UserLookup;
  if (email !== undefined) {
    lookup = { by: 'email', value: email };
  } else if (phone !== undefined) {
    lookup = { by: 'phone', value: normalizePhone(phone) };
  } else {
    throw new Error('需要 --email <邮箱> 或 --phone <手机号>');
  }

  const limit = parseLimit(values.get('limit'));
  const grantRaw = values.get('grant');
  if (grantRaw === undefined) return { kind: 'show', lookup, limit };

  return {
    kind: 'grant',
    lookup,
    amountCr: parseGrant(grantRaw, values.has('force')),
    note: values.get('note') ?? null,
    limit,
  };
}

/**
 * `--flag value` 形态的解析，第三次抄这一份（`content-cli` / `user-tier-cli`）。
 *
 * 差别只有一处：这里要支持**无值开关**（`--force`），因此下一个 token
 * 以 `--` 开头时不再报错，而是把这个 flag 记成空串。
 */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const valueless = new Set(['force']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // 裸 `--` 是 pnpm 的参数分隔符，会被原样透传进 argv
    if (token === undefined || token === '--' || !token.startsWith('--')) continue;
    const name = token.slice(2);

    if (valueless.has(name)) {
      values.set(name, '');
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`选项 ${token} 缺少取值`);
    }
    values.set(name, next);
    i += 1;
  }

  return values;
}

/**
 * 手机号归一成 E.164，与 `routes/auth.ts` 的 `PhoneSchema` 同一形态。
 *
 * 不归一的话 `--phone 13800000000` 查不到任何人（库里存的是 `+8613800000000`），
 * 而那看起来像「这个用户不存在」。
 */
export function normalizePhone(raw: string): string {
  const digits = raw.trim().replace(/^\+?86/, '');
  if (!/^1[3-9]\d{9}$/.test(digits)) {
    throw new Error(`--phone 不是合法的手机号：${raw}`);
  }
  return `+86${digits}`;
}

function parseGrant(raw: string, force: boolean): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--grant 需要正整数 CR，收到：${raw}`);
  }
  if (!force && value > MAX_GRANT_CR) {
    throw new Error(
      `--grant ${value} CR 超过单次上限 ${MAX_GRANT_CR}（约 ${MAX_GRANT_CR / 1000} 元）。` +
        '确认无误再加 --force —— 多授出去的 CR 没有撤销入口。',
    );
  }
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HISTORY_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit 取值非法：${raw}`);
  }
  return value;
}

export function describeLookup(lookup: UserLookup): string {
  return lookup.by === 'email' ? `邮箱 ${lookup.value}` : `手机号 ${lookup.value}`;
}

/** 一行流水。金额右对齐，方向由符号本身表达 */
export function formatEntry(entry: LedgerEntry): string {
  const amount = `${entry.amountCr > 0 ? '+' : ''}${entry.amountCr}`;
  return [
    entry.createdAt.slice(0, 19).replace('T', ' '),
    entry.kind.padEnd(9),
    amount.padStart(10),
    `余额 ${entry.balanceAfterCr}`,
    entry.refType === null ? '' : `${entry.refType} ${entry.refId ?? ''}`,
  ]
    .join('  ')
    .trimEnd();
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const config = loadCreditConfig();
  const pool = createPool(loadDbConfig());
  const users = createUsersRepository(pool);
  const wallet = createCreditWalletRepository(pool);

  try {
    const user =
      command.lookup.by === 'email'
        ? await users.findActiveByEmail(command.lookup.value)
        : await users.findActiveByPhone(command.lookup.value);

    if (user === null) {
      /*
       * 退出码非 0：这条命令会出现在批量脚本里（给一批用户补偿），
       * 静默成功会让「手机号拼错了」变成「授完了但没生效」。
       */
      throw new Error(`没有${describeLookup(command.lookup)}的 ACTIVE 用户`);
    }

    if (command.kind === 'grant') {
      /*
       * 幂等键用随机 UUID，因此**重跑会再授一次**。
       *
       * 换成「按用户 + 金额」派生的确定性键能防住重跑，但那会让「同一个用户
       * 补偿两次同样的金额」这种正常操作被静默吞掉 —— 而那比多授一次更难发现。
       * 命令末尾打印余额，人能当场看出授没授上。
       */
      const result = await wallet.credit({
        userId: user.id,
        amountCr: command.amountCr,
        kind: 'GRANT',
        idempotencyKey: `admin:${randomUUID()}`,
        refType: 'ADMIN',
        refId: 'cli',
        ...(command.note === null ? {} : { metadata: { note: command.note } }),
      });
      process.stdout.write(
        `已授予 ${command.amountCr} CR（约 ${creditsToCnyText(command.amountCr, config)} 元）` +
          `，当前余额 ${result.balanceCr} CR\n`,
      );
    }

    const balance = await wallet.balance(user.id);
    process.stdout.write(
      `\n${describeLookup(command.lookup)}  ${user.id}\n` +
        `余额 ${balance.balanceCr} CR（约 ${creditsToCnyText(balance.balanceCr, config)} 元）` +
        `，冻结 ${balance.heldCr} CR\n` +
        /* 一次 5 天行程按占位价约 3 元 —— 给运维一个「够用几次」的直觉 */
        `注册赠送额 ${config.signupGrantCr} CR，1 元 = ${config.crPerCny} CR\n`,
    );

    const entries = await wallet.history({ userId: user.id, limit: command.limit });
    if (entries.length === 0) {
      process.stdout.write('\n（没有流水）\n');
      return;
    }
    process.stdout.write(`\n${entries.map(formatEntry).join('\n')}\n`);
    if (entries.length === command.limit) {
      process.stdout.write(`\n（已达 --limit ${command.limit}，流水可能被截断）\n`);
    }
  } finally {
    await pool.end();
  }
}

// 仅在被直接执行时跑 main，被测试 import 时不跑（与 user-tier-cli 一致）
if (process.argv[1]?.includes('user-credit-cli') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`user:credit 失败：${String(error)}\n`);
    process.exitCode = 1;
  });
}
