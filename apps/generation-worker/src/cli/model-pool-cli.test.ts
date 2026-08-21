import { describe, expect, it } from 'vitest';

import { formatMapping, formatPool, parseArgs } from './model-pool-cli.js';

/**
 * `pnpm model:pool` 的参数解析与输出（多模型 failover 计划的任务 5）。
 *
 * 两条断言值得单列：
 *   - **`--models` 为空被拒**：空池的语义会是「这一档不许用 AI」，而调用方
 *     把它当成「无配置」回落 env —— 两件事必须在写入时就分开（迁移 0009
 *     的 `model_pools_models_nonempty` 是第二道）；
 *   - **`--list` 显示被截断后的实际候选数**：只显示配置值的话，运营把
 *     `max_candidates` 调到 10 会看到「10」并以为生效了，而运行时只试 2 个。
 */

const IMAGE_BUDGET = { perAttemptMs: 40_000, totalBudgetMs: 80_000 };

describe('parseArgs', () => {
  it('--list 是布尔开关，不吞后面的参数', () => {
    expect(parseArgs(['--list'])).toEqual({ kind: 'list' });
  });

  it('--set-pool 收集池名、类型与有序模型列表', () => {
    expect(
      parseArgs(['--set-pool', 'paid', '--kind', 'LLM', '--models', 'gpt-4o,claude-opus-4']),
    ).toEqual({
      kind: 'set-pool',
      name: 'paid',
      poolKind: 'LLM',
      models: ['gpt-4o', 'claude-opus-4'],
      note: null,
      dryRun: false,
    });
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
      IMAGE_BUDGET,
    );

    expect(line).toContain('上限 10');
    expect(line).toContain('实际 2');
    expect(line).toContain('被时延预算削过');
  });

  it('没被削时不加噪音标注', () => {
    const line = formatMapping(
      { kind: 'IMAGE', minTierLevel: 0, poolName: 'paid', maxCandidates: 1 },
      pool,
      IMAGE_BUDGET,
    );

    expect(line).toContain('实际 1');
    expect(line).not.toContain('削过');
  });

  it('文本侧不做时延截断，实际数就是配置值', () => {
    const line = formatMapping(
      { kind: 'LLM', minTierLevel: 0, poolName: 'free', maxCandidates: 3 },
      { name: 'free', kind: 'LLM', models: ['m1', 'm2', 'm3', 'm4', 'm5'], note: null },
      IMAGE_BUDGET,
    );

    expect(line).toContain('实际 3');
    expect(line).not.toContain('削过');
  });

  it('上限为 NULL 时显示「不限」并列出整池', () => {
    const line = formatMapping(
      { kind: 'LLM', minTierLevel: 10, poolName: 'paid', maxCandidates: null },
      { name: 'paid', kind: 'LLM', models: ['p1', 'p2'], note: null },
      IMAGE_BUDGET,
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
      IMAGE_BUDGET,
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
