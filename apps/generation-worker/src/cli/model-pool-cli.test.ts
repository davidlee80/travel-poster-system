import { describe, expect, it } from 'vitest';

import {
  formatMapping,
  formatOverwriteNotice,
  formatPool,
  parseArgs,
} from './model-pool-cli.js';

/**
 * `pnpm model:pool` 的参数解析与输出（多模型 failover 计划的任务 5）。
 *
 * 四条断言值得单列：
 *   - **`--models` 为空被拒**：空池的语义会是「这一档不许用 AI」，而调用方
 *     把它当成「无配置」回落 env —— 两件事必须在写入时就分开（迁移 0009
 *     的 `model_pools_models_nonempty` 是第二道）；
 *   - **`--list` 显示被截断后的实际候选数**：只显示配置值的话，运营把
 *     `max_candidates` 调到 10 会看到「10」并以为生效了，而运行时只试 2 个；
 *   - **不传 `--note` 时属性被省掉**（不是传 `null`）：下游据此保留原备注。
 *     曾经这里传 `null` 而 SQL 是 `note = EXCLUDED.note`，于是「只改模型顺序」
 *     会静默抹掉备注 —— 而改顺序恰好是应急操作；
 *   - **回退命令的 `--models` 不带空格**：带了就不能直接粘贴（shell 会拆词），
 *     而它存在的全部意义就是可粘贴。
 */

const BUDGETS = {
  // 默认 env：IMAGE_TIMEOUT_MS / IMAGE_JOB_AI_BUDGET_MS
  image: { perAttemptMs: 40_000, totalBudgetMs: 80_000 },
  // 默认 env 的 LLM_TIMEOUT_MS 与 LLM_CHAIN_BUDGET_MS（300 秒的三分之一）
  llm: { perAttemptMs: 30_000, totalBudgetMs: 100_000 },
};

describe('parseArgs', () => {
  it('--list 是布尔开关，不吞后面的参数', () => {
    expect(parseArgs(['--list'])).toEqual({ kind: 'list' });
  });

  it('--set-pool 收集池名、类型与有序模型列表；不传 --note 时省掉该属性', () => {
    const command = parseArgs([
      '--set-pool',
      'paid',
      '--kind',
      'LLM',
      '--models',
      'openai/gpt-5.5,anthropic/claude-opus-4.8',
    ]);

    expect(command).toEqual({
      kind: 'set-pool',
      name: 'paid',
      poolKind: 'LLM',
      models: ['openai/gpt-5.5', 'anthropic/claude-opus-4.8'],
      dryRun: false,
    });

    /*
     * 属性必须**不存在**，而不是值为 null。
     *
     * `upsertPool` 靠 `input.note !== undefined` 判「本次是否动备注」；
     * 传 null 会被当成「显式清空」，于是只改模型顺序就抹掉了备注。
     * `toEqual` 不区分两者，因此这一行必须单独写。
     */
    expect('note' in command).toBe(false);
  });

  it('--note 传内容时设置，传空串时显式清空', () => {
    expect(
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a', '--note', '只放便宜模型']),
    ).toMatchObject({ note: '只放便宜模型' });

    // 空串与纯空白都归为「显式清空」（null），与「不传」区分开
    expect(
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a', '--note', '']),
    ).toMatchObject({ note: null });
    expect(
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a', '--note', '   ']),
    ).toMatchObject({ note: null });
  });

  it('模型名内部含空白被拒（PowerShell 不加引号的 a,b）', () => {
    /*
     * PowerShell 把不加引号的 `--models a,b` 展开成数组再用空格拼回，
     * 于是 CLI 收到一个字符串 `"a b"`。它切完逗号只得到**一个**模型名，
     * 而那个名字在中转站上不存在。
     *
     * 不拦的后果是静默的：它会被写进数据库，`--list` 看上去正常，
     * 而那一档的每次调用都失败 —— 已经在本机真实发生过一次。
     */
    expect(() =>
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'openai/gpt-5.5 google/gemini-3.5-flash']),
    ).toThrow(/不能含空白/);

    // 提示必须包含解法，否则运营看不出该怎么改
    expect(() =>
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a b']),
    ).toThrow(/加引号/);
  });

  it('模型名两侧的空格被裁掉（复制粘贴常带空格）', () => {
    expect(parseArgs(['--set-pool', 'p', '--kind', 'IMAGE', '--models', ' a , b '])).toMatchObject({
      models: ['a', 'b'],
    });
  });

  it('--kind 大小写不敏感', () => {
    expect(parseArgs(['--set-pool', 'p', '--kind', 'image', '--models', 'a'])).toMatchObject({
      poolKind: 'IMAGE',
    });
  });

  it('--map 省略 --max-candidates 即不限（遍历整个池）', () => {
    expect(parseArgs(['--map', '--kind', 'LLM', '--min-tier', '10', '--pool', 'paid'])).toEqual({
      kind: 'map',
      poolKind: 'LLM',
      minTierLevel: 10,
      poolName: 'paid',
      maxCandidates: null,
      dryRun: false,
    });
  });

  it('--dry-run 与两个写命令都能组合', () => {
    expect(
      parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a', '--dry-run']),
    ).toMatchObject({ dryRun: true });
    expect(
      parseArgs(['--map', '--kind', 'LLM', '--min-tier', '0', '--pool', 'p', '--dry-run']),
    ).toMatchObject({ dryRun: true });
  });

  it('--models 为空被拒，报文解释空池与无配置的区别', () => {
    expect(() => parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', ','])).toThrow(
      /空池与「无配置」/,
    );
  });

  it('--models 有重复项被拒（同一个模型被试两次纯属白花请求）', () => {
    expect(() => parseArgs(['--set-pool', 'p', '--kind', 'LLM', '--models', 'a,b,a'])).toThrow(
      /重复/,
    );
  });

  it('--kind 取值非法时列出合法值', () => {
    expect(() => parseArgs(['--set-pool', 'p', '--kind', 'TEXT', '--models', 'a'])).toThrow(
      /LLM \/ IMAGE/,
    );
  });

  it('--max-candidates 为 0 被拒（0 个候选等于关掉 AI，不该用这个字段表达）', () => {
    expect(() =>
      parseArgs([
        '--map',
        '--kind',
        'LLM',
        '--min-tier',
        '0',
        '--pool',
        'p',
        '--max-candidates',
        '0',
      ]),
    ).toThrow(/≥ 1/);
  });

  it('什么动作都不给时报错', () => {
    expect(() => parseArgs([])).toThrow(/--list|--set-pool|--map/);
  });

  it('--unmap 是布尔开关，需要 --kind 与 --min-tier', () => {
    /*
     * 删映射是迁移 0009 承诺的回滚路径（「清空 tier_model_pools 即可」）。
     * 池配错导致大面积 failover 时，这是最需要的那个操作 ——
     * 而它一度只能拿 psql 连生产库手写 DELETE。
     */
    expect(parseArgs(['--unmap', '--kind', 'IMAGE', '--min-tier', '10'])).toEqual({
      kind: 'unmap',
      poolKind: 'IMAGE',
      minTierLevel: 10,
      dryRun: false,
    });

    expect(() => parseArgs(['--unmap', '--kind', 'IMAGE'])).toThrow(/min-tier/);
  });

  it('--drop-pool 取池名，需要 --kind（同名池在两个 kind 下各有内容）', () => {
    expect(parseArgs(['--drop-pool', 'paid', '--kind', 'LLM'])).toEqual({
      kind: 'drop-pool',
      name: 'paid',
      poolKind: 'LLM',
      dryRun: false,
    });
  });

  it('--dry-run 与两个删除命令也能组合', () => {
    // 回滚场合下先看一眼要动什么，比其他任何时候都重要
    expect(parseArgs(['--unmap', '--kind', 'LLM', '--min-tier', '0', '--dry-run'])).toMatchObject({
      dryRun: true,
    });
    expect(parseArgs(['--drop-pool', 'p', '--kind', 'LLM', '--dry-run'])).toMatchObject({
      dryRun: true,
    });
  });
});

describe('--list 的实际候选数', () => {
  const pool = {
    name: 'paid',
    kind: 'IMAGE' as const,
    models: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    note: null,
  };

  it('图像侧被时延预算削过时显示实际值并标注', () => {
    const line = formatMapping(
      { kind: 'IMAGE', minTierLevel: 10, poolName: 'paid', maxCandidates: 10 },
      pool,
      BUDGETS,
    );

    expect(line).toContain('上限 10');
    expect(line).toContain('实际 2');
    expect(line).toContain('被时延预算削过');
  });

  it('没被削时不加噪音标注', () => {
    const line = formatMapping(
      { kind: 'IMAGE', minTierLevel: 0, poolName: 'paid', maxCandidates: 1 },
      pool,
      BUDGETS,
    );

    expect(line).toContain('实际 1');
    expect(line).not.toContain('削过');
  });

  it('文本侧在链预算内时实际数就是配置值', () => {
    // 30 秒/候选 × 3 = 90 秒，装得进 100 秒的单链预算
    const line = formatMapping(
      { kind: 'LLM', minTierLevel: 0, poolName: 'free', maxCandidates: 3 },
      { name: 'free', kind: 'LLM', models: ['m1', 'm2', 'm3', 'm4', 'm5'], note: null },
      BUDGETS,
    );

    expect(line).toContain('实际 3');
    expect(line).not.toContain('削过');
  });

  it('文本侧超出链预算时同样被削，并用文本自己的预算算', () => {
    /*
     * 曾经文本侧在这里手写 `slice(0, min(max, size))` 且从不标注削减，
     * 于是运营把 max_candidates 配成 10 时 `--list` 显示「实际 10」——
     * 而 Worker 只会试到任务预算耗尽。两处各一份实现，这就是分叉的样子。
     *
     * 用的必须是文本自己的预算（30 秒 / 100 秒），不是图像那套。
     */
    const line = formatMapping(
      { kind: 'LLM', minTierLevel: 20, poolName: 'paid', maxCandidates: 10 },
      {
        name: 'paid',
        kind: 'LLM',
        models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'],
        note: null,
      },
      BUDGETS,
    );

    expect(line).toContain('上限 10');
    // floor(100000 / 30000) = 3
    expect(line).toContain('实际 3');
    expect(line).toContain('被时延预算削过');
    expect(line).toContain('30000 毫秒/候选');
  });

  it('上限为 NULL 时显示「不限」并列出整池', () => {
    const line = formatMapping(
      { kind: 'LLM', minTierLevel: 10, poolName: 'paid', maxCandidates: null },
      { name: 'paid', kind: 'LLM', models: ['p1', 'p2'], note: null },
      BUDGETS,
    );

    expect(line).toContain('上限 不限');
    expect(line).toContain('实际 2');
    expect(line).toContain('p1 → p2');
  });

  it('映射指向的池不存在时显式喊出来，而不是显示成 0 个候选', () => {
    /*
     * 外键理论上不允许，但真出现时（手工改库、迁移半途）显示成
     * 「实际 0」会被读成「这一档被关掉了」，而它其实是数据坏了。
     */
    const line = formatMapping(
      { kind: 'IMAGE', minTierLevel: 0, poolName: 'ghost', maxCandidates: 1 },
      undefined,
      BUDGETS,
    );
    expect(line).toContain('池不存在');
  });
});

describe('formatPool', () => {
  it('按顺序列出模型名，备注可选', () => {
    expect(formatPool({ name: 'paid', kind: 'LLM', models: ['a', 'b'], note: '付费' })).toContain(
      '[a, b]',
    );
    expect(formatPool({ name: 'paid', kind: 'LLM', models: ['a'], note: null })).not.toContain('#');
  });
});

describe('formatOverwriteNotice', () => {
  it('新建池时不给回退命令（无旧值可退）', () => {
    const notice = formatOverwriteNotice(undefined, 'paid', 'LLM');
    expect(notice).toContain('新建');
    expect(notice).not.toContain('--set-pool');
  });

  it('覆盖时给出旧值、旧备注与一条可粘贴的回退命令', () => {
    const notice = formatOverwriteNotice(
      {
        name: 'paid',
        kind: 'LLM',
        models: ['openai/gpt-5.5', 'google/gemini-3.5-flash'],
        note: '只放便宜模型',
      },
      'paid',
      'LLM',
    );

    expect(notice).toContain('[openai/gpt-5.5, google/gemini-3.5-flash]');
    expect(notice).toContain('只放便宜模型');
    expect(notice).toContain(
      'pnpm model:pool -- --set-pool paid --kind LLM ' +
        '--models "openai/gpt-5.5,google/gemini-3.5-flash"',
    );
  });

  it('回退命令的 --models 带引号、不带空格，也不带 --note', () => {
    const notice = formatOverwriteNotice(
      { name: 'p', kind: 'IMAGE', models: ['a', 'b', 'c'], note: '带空格 的 备注' },
      'p',
      'IMAGE',
    );

    const command = notice
      .split('\n')
      .find((row) => row.includes('pnpm model:pool'))
      ?.trim();

    /*
     * 三条都是「能不能直接粘贴」的条件：
     *   - `--models a, b, c` 会被 shell 拆成三个参数，`b` 与 `c` 成了游离项；
     *   - **不带引号时 PowerShell 会把 `a,b,c` 展开成数组再用空格拼回**，
     *     于是粘贴回去得到一个含空格的假模型名 —— 已在本机真实发生过；
     *   - 带上 `--note "带空格 的 备注"` 就得处理引号转义，而备注本来就会被
     *     `upsertPool` 在缺省时保留 —— 加上只会多一个出错点。
     */
    expect(command).toBe('pnpm model:pool -- --set-pool p --kind IMAGE --models "a,b,c"');
  });
});
