import {
  createPool,
  createTierAdminRepository,
  loadDbConfig,
  resolveCandidates,
  type ModelPoolKind,
  type ModelPoolRow,
  type TierMappingRow,
} from '@tps/db';
import { loadImageConfig, loadLlmConfig } from '@tps/llm';

import { LLM_CHAIN_BUDGET_MS } from '../assets/model-selection.js';

/**
 * 模型候选池与 tier 映射的运维 CLI（多模型 failover 计划的任务 5，迁移 0009）。
 *
 * ```bash
 * pnpm model:pool -- --list
 * pnpm model:pool -- --set-pool paid --kind LLM --models gpt-4o,claude-opus-4
 * pnpm model:pool -- --map --kind LLM --min-tier 10 --pool paid --max-candidates 3
 * pnpm model:pool -- --map --kind IMAGE --min-tier 10 --pool paid   # 省略即不限
 * pnpm model:pool -- --set-pool paid --kind LLM --models a,b --dry-run
 *
 * # 回滚：删映射即回落 env 单模型（迁移 0009 承诺的那条路）
 * pnpm model:pool -- --unmap --kind IMAGE --min-tier 10
 * pnpm model:pool -- --drop-pool paid --kind IMAGE   # 仍被映射引用时会拒绝并告知档位
 * ```
 *
 * 只需 `DATABASE_URL`（`--list` 另读 `IMAGE_*` / `LLM_*` 以算实际候选数）。
 *
 * ## 为什么放在 generation-worker 而不是 api
 *
 * 它要算「实际生效的候选数」，因此需要 `@tps/llm` 的超时与预算配置 ——
 * 而 `apps/api` 刻意不依赖模型访问层（它不调模型）。与 `content:find`
 * 放在 retention-worker 是同一个判断：CLI 落在依赖已经齐备的那个包里，
 * 而不是让一个面向公网的进程为了一条运维命令多长出一整条依赖链。
 * generation-worker 正是消费这两张表的进程。
 *
 * ## `--list` 为什么必须显示「实际候选数」
 *
 * 图像侧的候选数会被时延预算**截断**（见 `resolveCandidates`）：配 10 个而
 * 预算只够 2 个时，运行时只试 2 个。只显示配置值的话，运营调完看到「10」
 * 就以为生效了 —— 而「为什么成功率没上去」这个问题从这里根本查不出来。
 *
 * ## 为什么不校验模型名是否真实存在
 *
 * 中转站没有可靠的模型列表接口。配错的后果是那个候选快速失败、链条切到
 * 下一个，代价是每次多一个无效请求 —— 靠 `--dry-run` 与 failover 指标发现，
 * 而不是靠一个会过期的白名单。这一条写在计划的「交付边界」里。
 */

const KINDS: readonly ModelPoolKind[] = ['LLM', 'IMAGE'];

export type ModelPoolCommand =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'set-pool';
      readonly name: string;
      readonly poolKind: ModelPoolKind;
      readonly models: readonly string[];
      readonly note: string | null;
      readonly dryRun: boolean;
    }
  | {
      readonly kind: 'map';
      readonly poolKind: ModelPoolKind;
      readonly minTierLevel: number;
      readonly poolName: string;
      readonly maxCandidates: number | null;
      readonly dryRun: boolean;
    }
  | {
      readonly kind: 'unmap';
      readonly poolKind: ModelPoolKind;
      readonly minTierLevel: number;
      readonly dryRun: boolean;
    }
  | {
      readonly kind: 'drop-pool';
      readonly name: string;
      readonly poolKind: ModelPoolKind;
      readonly dryRun: boolean;
    };

export function parseArgs(argv: readonly string[]): ModelPoolCommand {
  const { values, flags } = parseFlags(argv);
  const dryRun = flags.has('dry-run');

  if (flags.has('list')) return { kind: 'list' };

  const setPool = values.get('set-pool');
  if (setPool !== undefined) {
    const models = parseModels(values.get('models'));
    return {
      kind: 'set-pool',
      name: setPool,
      poolKind: parseKind(values.get('kind')),
      models,
      note: values.get('note') ?? null,
      dryRun,
    };
  }

  if (flags.has('map')) {
    const poolName = values.get('pool');
    if (poolName === undefined) throw new Error('--map 需要 --pool <池名>');
    return {
      kind: 'map',
      poolKind: parseKind(values.get('kind')),
      minTierLevel: parseNonNegativeInt(requireValue(values, 'min-tier'), '--min-tier'),
      poolName,
      maxCandidates: parseMaxCandidates(values.get('max-candidates')),
      dryRun,
    };
  }

  if (flags.has('unmap')) {
    return {
      kind: 'unmap',
      poolKind: parseKind(values.get('kind')),
      minTierLevel: parseNonNegativeInt(requireValue(values, 'min-tier'), '--min-tier'),
      dryRun,
    };
  }

  const dropPool = values.get('drop-pool');
  if (dropPool !== undefined) {
    return {
      kind: 'drop-pool',
      name: dropPool,
      poolKind: parseKind(values.get('kind')),
      dryRun,
    };
  }

  throw new Error('需要 --list、--set-pool <池名>、--map、--unmap 或 --drop-pool <池名> 之一');
}

/**
 * 同时支持 `--flag value` 与布尔开关（`--list`、`--map`、`--dry-run`）。
 *
 * 与 `content-cli.ts` 的解析器差在这里：那个 CLI 没有布尔开关，因此
 * 「下一个词不是取值」一律报错。这里必须区分两者，否则 `--list` 会去
 * 吞掉后面的东西，或者在它是最后一个参数时报「缺少取值」。
 */
const BOOLEAN_FLAGS: readonly string[] = ['list', 'map', 'unmap', 'dry-run'];

function parseFlags(argv: readonly string[]): {
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // 裸 `--` 是 pnpm 的参数分隔符，会被原样透传进 argv
    if (token === undefined || token === '--' || !token.startsWith('--')) continue;

    const name = token.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      flags.add(name);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`选项 ${token} 缺少取值`);
    }
    values.set(name, next);
    i += 1;
  }

  return { values, flags };
}

function requireValue(values: Map<string, string>, name: string): string {
  const raw = values.get(name);
  if (raw === undefined) throw new Error(`缺少 --${name}`);
  return raw;
}

function parseKind(raw: string | undefined): ModelPoolKind {
  if (raw === undefined) throw new Error(`缺少 --kind（应为 ${KINDS.join(' / ')}）`);
  const upper = raw.toUpperCase();
  if (!KINDS.includes(upper as ModelPoolKind)) {
    throw new Error(`--kind 取值非法：${raw}（应为 ${KINDS.join(' / ')}）`);
  }
  return upper as ModelPoolKind;
}

/**
 * 逗号分隔的模型名列表。
 *
 * 空列表在这里就拒掉，而不是等数据库的 `model_pools_models_nonempty`：
 * 那条约束存在的理由是「空池」与「没有配置」必须区分（前者的语义会是
 * 「这一档不许用 AI」，而调用方把它当成无配置回落 env）。让 CLI 先报错
 * 是为了给出这句解释 —— 数据库只会说 violates check constraint。
 */
function parseModels(raw: string | undefined): readonly string[] {
  if (raw === undefined) throw new Error('--set-pool 需要 --models a,b,c');
  const models = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (models.length === 0) {
    throw new Error('--models 至少要有一个模型名（空池与「无配置」是两件事，见迁移 0009）');
  }
  const unique = new Set(models);
  if (unique.size !== models.length) {
    // 重复的候选只会让同一个模型被试两次，白花一次请求
    throw new Error(`--models 有重复项：${models.join(',')}`);
  }
  return models;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} 需要非负整数，收到：${raw}`);
  }
  return value;
}

/** 省略即 NULL（不限，用满整个池）。给了就必须 ≥ 1 */
function parseMaxCandidates(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-candidates 需要 ≥ 1 的整数（省略表示不限），收到：${raw}`);
  }
  return value;
}

// ── 输出 ────────────────────────────────────────────────────

export interface EffectiveCountInput {
  readonly perAttemptMs: number;
  readonly totalBudgetMs: number;
}

/**
 * 一行映射的可读形式，含**实际生效**的候选数。
 *
 * 两侧都走 `resolveCandidates`（与 Worker 同一个函数，因此不可能分叉），
 * 只是预算来源不同：图像是 21.2 的素材窗口，文本是 16.3 的 300 秒任务上限
 * 里一条链的份额（`LLM_CHAIN_BUDGET_MS`）。
 *
 * 文本侧曾经在这里手写 `slice(0, min(max, size))` —— 与 Worker 各一份，
 * 而这个函数的全部用途就是让运营看到 Worker 实际会试几个。
 */
export function formatMapping(
  mapping: TierMappingRow,
  pool: ModelPoolRow | undefined,
  budgets: { readonly image: EffectiveCountInput; readonly llm: EffectiveCountInput },
): string {
  const poolSize = pool?.models.length ?? 0;
  const configured = mapping.maxCandidates === null ? '不限' : String(mapping.maxCandidates);

  if (pool === undefined) {
    // 外键理论上不允许，但真出现时要看得见而不是显示成 0 个候选
    return `${mapping.kind}  tier ≥ ${mapping.minTierLevel}  → ${mapping.poolName}（池不存在！）`;
  }

  const budget = mapping.kind === 'IMAGE' ? budgets.image : budgets.llm;
  const effective = resolveCandidates({
    models: pool.models,
    maxCandidates: mapping.maxCandidates,
    perAttemptMs: budget.perAttemptMs,
    totalBudgetMs: budget.totalBudgetMs,
  });

  const clampNote = effective.clamped
    ? `  ← 被时延预算削过（${budget.perAttemptMs} 毫秒/候选，预算 ${budget.totalBudgetMs} 毫秒）`
    : '';

  return (
    `${mapping.kind.padEnd(5)}  tier ≥ ${String(mapping.minTierLevel).padStart(3)}` +
    `  → ${mapping.poolName}（池 ${poolSize} 个，上限 ${configured}，` +
    `实际 ${effective.candidates.length}：${effective.candidates.join(' → ')}）${clampNote}`
  );
}

export function formatPool(pool: ModelPoolRow): string {
  return (
    `${pool.kind.padEnd(5)}  ${pool.name}  [${pool.models.join(', ')}]` +
    (pool.note === null ? '' : `  # ${pool.note}`)
  );
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  const pool = createPool(loadDbConfig());
  const repository = createTierAdminRepository(pool);

  try {
    if (command.kind === 'list') {
      const imageConfig = loadImageConfig();
      const llmConfig = loadLlmConfig();
      const [pools, mappings] = await Promise.all([
        repository.listPools(),
        repository.listMappings(),
      ]);

      process.stdout.write(
        `单候选超时：图像 ${imageConfig.timeoutMs} 毫秒 / 文本 ${llmConfig.timeoutMs} 毫秒；` +
          `链预算：图像 ${imageConfig.jobAiBudgetMs} 毫秒（素材窗口）/ ` +
          `文本 ${LLM_CHAIN_BUDGET_MS} 毫秒（300 秒任务上限的三分之一）\n\n`,
      );

      process.stdout.write(
        pools.length === 0
          ? '池：（无）—— 系统回落到 LLM_MODEL / IMAGE_MODEL 的单模型行为\n'
          : `池：\n${pools.map((row) => `  ${formatPool(row)}`).join('\n')}\n`,
      );

      const byKey = new Map(pools.map((row) => [`${row.kind}:${row.name}`, row]));
      process.stdout.write(
        mappings.length === 0
          ? '\n映射：（无）—— 任何等级都回落到单模型\n'
          : `\n映射：\n${mappings
              .map(
                (row) =>
                  `  ${formatMapping(row, byKey.get(`${row.kind}:${row.poolName}`), {
                    image: {
                      perAttemptMs: imageConfig.timeoutMs,
                      totalBudgetMs: imageConfig.jobAiBudgetMs,
                    },
                    llm: {
                      perAttemptMs: llmConfig.timeoutMs,
                      totalBudgetMs: LLM_CHAIN_BUDGET_MS,
                    },
                  })}`,
              )
              .join('\n')}\n`,
      );
      return;
    }

    if (command.kind === 'set-pool') {
      const line = `${command.poolKind} 池 ${command.name} = [${command.models.join(', ')}]`;
      if (command.dryRun) {
        process.stdout.write(`--dry-run：将写入 ${line}\n`);
        return;
      }
      await repository.upsertPool({
        name: command.name,
        kind: command.poolKind,
        models: command.models,
        note: command.note,
      });
      process.stdout.write(`已写入 ${line}\n`);
      return;
    }

    if (command.kind === 'unmap') {
      const line = `${command.poolKind} tier ≥ ${command.minTierLevel} 的映射`;
      if (command.dryRun) {
        process.stdout.write(`--dry-run：将删除 ${line}\n`);
        return;
      }
      const removed = await repository.deleteMapping(command.poolKind, command.minTierLevel);
      process.stdout.write(
        removed
          ? `已删除 ${line}\n这一档回落到 ${command.poolKind === 'LLM' ? 'LLM_MODEL' : 'IMAGE_MODEL'}` +
              ` 的单模型行为。\n（Worker 侧最多 60 秒后生效，见池缓存 TTL）\n`
          : // 回滚场合下「档位打错了」必须看得见，不能和「删掉了」长一样
            `没有 ${line} —— 什么都没删。用 --list 确认档位。\n`,
      );
      if (!removed) process.exitCode = 1;
      return;
    }

    if (command.kind === 'drop-pool') {
      const line = `${command.poolKind} 池 ${command.name}`;
      if (command.dryRun) {
        process.stdout.write(`--dry-run：将删除 ${line}\n`);
        return;
      }
      const result = await repository.deletePool(command.name, command.poolKind);
      if (result.referencedBy.length > 0) {
        /*
         * 不删。先说清哪几档还指着它 —— 外键的报错不回答这个问题，
         * 而它正是下一步要做的事。
         */
        process.stdout.write(
          `未删除 ${line}：还有 ${result.referencedBy.length} 档映射指向它` +
            `（tier ≥ ${result.referencedBy.join('、tier ≥ ')}）。\n` +
            `先删映射：${result.referencedBy
              .map(
                (tier) =>
                  `pnpm model:pool -- --unmap --kind ${command.poolKind} --min-tier ${tier}`,
              )
              .join('\n          ')}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(result.deleted ? `已删除 ${line}\n` : `没有 ${line} —— 什么都没删。\n`);
      if (!result.deleted) process.exitCode = 1;
      return;
    }

    const limit = command.maxCandidates === null ? '不限' : String(command.maxCandidates);
    const line =
      `${command.poolKind} tier ≥ ${command.minTierLevel} → 池 ${command.poolName}` +
      `（候选上限 ${limit}）`;
    if (command.dryRun) {
      process.stdout.write(`--dry-run：将写入 ${line}\n`);
      return;
    }
    await repository.upsertMapping({
      kind: command.poolKind,
      minTierLevel: command.minTierLevel,
      poolName: command.poolName,
      maxCandidates: command.maxCandidates,
    });
    process.stdout.write(`已写入 ${line}\n（Worker 侧最多 60 秒后生效，见池缓存 TTL）\n`);
  } finally {
    await pool.end();
  }
}

// 仅在被直接执行时跑 main，被测试 import 时不跑（与 content-cli 一致）
if (process.argv[1]?.includes('model-pool-cli') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`model:pool 失败：${String(error)}\n`);
    process.exitCode = 1;
  });
}
