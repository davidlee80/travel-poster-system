import { describe, expect, it } from 'vitest';

import {
  JOB_STAGE_DISPLAY,
  JOB_STATUS_VALUES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATUSES,
  canTransition,
  isTerminalJobStatus,
  nextProgress,
  stageMessage,
  type JobStatus,
} from './job-status.js';

/**
 * 任务状态机（TP-2-16，设计稿 16.1、16.2）。
 *
 * 两条不变量是这里的核心：
 *   1. `progress` **单调不减** —— 进度条倒退会让用户以为任务重新开始；
 *   2. 只有两条回边，其余严格前向 —— 多一条回边就可能成环，
 *      而成环的表现是任务永远跑不完，既不成功也不失败。
 */

describe('16.2 progress 与文案表', () => {
  it('17 个状态逐个有条目', () => {
    expect(JOB_STATUS_VALUES).toHaveLength(17);
    for (const status of JOB_STATUS_VALUES) {
      expect(JOB_STAGE_DISPLAY[status], `${status} 缺条目`).toBeDefined();
    }
  });

  it('RESOLVING_ASSETS 的 progress 是 76（对齐 13.2 的示例响应）', () => {
    // 13.2 的示例里写着 progress: 76。示例与实现不一致时，
    // 前端按示例写的期望值会一直对不上
    expect(JOB_STAGE_DISPLAY.RESOLVING_ASSETS.progress).toBe(76);
  });

  it('16.2 的表格逐行正确', () => {
    const actual = Object.fromEntries(
      JOB_STATUS_VALUES.map((status) => [status, JOB_STAGE_DISPLAY[status].progress]),
    );
    expect(actual).toEqual({
      QUEUED: 0,
      NORMALIZING: 4,
      VALIDATING_REQUEST: 8,
      RETRIEVING_REFERENCES: 14,
      GENERATING_PLAN: 20,
      VALIDATING_PLAN: 48,
      REPAIRING_PLAN: 54,
      SAVING_PLAN: 60,
      BUILDING_PRESENTATION: 66,
      RESOLVING_ASSETS: 76,
      GENERATING_ASSETS: 82,
      RENDERING_HTML: 90,
      EXPORTING_PNG: 94,
      EXPORTING_PDF: 97,
      COMPLETED: 100,
      // 16.2：保持进入该状态时的值
      FAILED: null,
      CANCELLED: null,
    });
  });

  it('progress 都在 0～100 内（与数据库 CHECK 一致）', () => {
    for (const status of JOB_STATUS_VALUES) {
      const progress = JOB_STAGE_DISPLAY[status].progress;
      if (progress === null) continue;
      expect(progress, `${status} 越界`).toBeGreaterThanOrEqual(0);
      expect(progress, `${status} 越界`).toBeLessThanOrEqual(100);
    }
  });

  it('除 FAILED 外都有中文文案', () => {
    for (const status of JOB_STATUS_VALUES) {
      if (status === 'FAILED') continue;
      expect(JOB_STAGE_DISPLAY[status].message, `${status} 缺文案`).toMatch(/[一-龥]/);
    }
  });

  it('FAILED 的文案由错误码提供，不用占位文案覆盖', () => {
    /*
     * 给 FAILED 一句「生成失败」占位，会覆盖掉
     * 「当前必选条件无法同时满足，请放宽部分条件后重试」——
     * 而那句话是用户唯一的下一步指引。
     */
    expect(JOB_STAGE_DISPLAY.FAILED.message).toBeNull();
    expect(stageMessage('FAILED', '当前必选条件无法同时满足，请放宽部分条件后重试。')).toBe(
      '当前必选条件无法同时满足，请放宽部分条件后重试。',
    );
  });

  it('缺错误文案时有兜底，不返回 undefined', () => {
    // 返回 undefined 会让前端渲染出「undefined」
    expect(stageMessage('FAILED')).toMatch(/[一-龥]/);
  });
});

describe('16.2 progress 单调不减', () => {
  it('回边不回退：REPAIRING_PLAN → VALIDATING_PLAN 停在 54', () => {
    expect(nextProgress(54, 'VALIDATING_PLAN')).toBe(54);
  });

  it('回边不回退：GENERATING_ASSETS → RESOLVING_ASSETS 停在 82', () => {
    expect(nextProgress(82, 'RESOLVING_ASSETS')).toBe(82);
  });

  it('FAILED 与 CANCELLED 保持进入时的值', () => {
    expect(nextProgress(76, 'FAILED')).toBe(76);
    expect(nextProgress(20, 'CANCELLED')).toBe(20);
  });

  it('沿任意合法路径推进，progress 永不下降', () => {
    /*
     * 穷举全部路径（含两条回边各走一次），逐步断言。
     * 手工挑几条路径测是不够的：回退只会在特定的一对状态间出现，
     * 而那一对恰好是最容易被漏掉的。
     */
    const walk = (status: JobStatus, progress: number, depth: number): void => {
      if (depth > 25) return;
      for (const next of JOB_TRANSITIONS[status]) {
        const updated = nextProgress(progress, next);
        expect(
          updated,
          `${status} → ${next} 让进度从 ${progress} 退到 ${updated}`,
        ).toBeGreaterThanOrEqual(progress);
        walk(next, updated, depth + 1);
      }
    };
    walk('QUEUED', 0, 0);
  });
});

describe('16.1 合法转移', () => {
  it('每个状态都有出边条目', () => {
    for (const status of JOB_STATUS_VALUES) {
      expect(JOB_TRANSITIONS[status], `${status} 缺出边条目`).toBeDefined();
    }
  });

  it('终态没有出边', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(JOB_TRANSITIONS[status]).toEqual([]);
      expect(isTerminalJobStatus(status)).toBe(true);
    }
  });

  it('终态不可再转移', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(canTransition(status, 'NORMALIZING')).toBe(false);
      expect(canTransition(status, 'FAILED')).toBe(false);
      expect(canTransition(status, 'CANCELLED')).toBe(false);
    }
  });

  it('任意非终态都能转到 FAILED 与 CANCELLED', () => {
    for (const status of JOB_STATUS_VALUES) {
      if (isTerminalJobStatus(status)) continue;
      expect(canTransition(status, 'FAILED'), `${status} 无法失败`).toBe(true);
      expect(canTransition(status, 'CANCELLED'), `${status} 无法取消`).toBe(true);
    }
  });

  it('只有两条回边，其余严格前向', () => {
    /*
     * 「前向」用 16.2 的 progress 值定序：除两条已知回边外，
     * 任何一条边的目标 progress 都必须大于源。多一条回边就可能成环，
     * 而成环的表现是任务永远跑不完 —— 既不成功也不失败，
     * 只能靠 300 秒的整体超时兜住。
     */
    const backEdges: string[] = [];
    for (const from of JOB_STATUS_VALUES) {
      for (const to of JOB_TRANSITIONS[from]) {
        const a = JOB_STAGE_DISPLAY[from].progress;
        const b = JOB_STAGE_DISPLAY[to].progress;
        if (a === null || b === null) continue;
        if (b <= a) backEdges.push(`${from}→${to}`);
      }
    }
    expect(backEdges.sort()).toEqual([
      'GENERATING_ASSETS→RESOLVING_ASSETS',
      'REPAIRING_PLAN→VALIDATING_PLAN',
    ]);
  });

  it('导出可跳过：两个开关都关时能从 RENDERING_HTML 直达 COMPLETED', () => {
    // 少了这条边，两个导出开关都关掉的任务会卡在 RENDERING_HTML
    expect(canTransition('RENDERING_HTML', 'COMPLETED')).toBe(true);
    expect(canTransition('EXPORTING_PNG', 'COMPLETED')).toBe(true);
  });

  it('不允许跳阶段', () => {
    expect(canTransition('QUEUED', 'GENERATING_PLAN')).toBe(false);
    expect(canTransition('SAVING_PLAN', 'RENDERING_HTML')).toBe(false);
  });

  it('从 QUEUED 出发能到达每一个状态', () => {
    // 到不了的状态是死代码，而它可能正是某个分支要写入的目标
    const seen = new Set<JobStatus>(['QUEUED']);
    const queue: JobStatus[] = ['QUEUED'];
    while (queue.length > 0) {
      const status = queue.shift()!;
      for (const next of [...JOB_TRANSITIONS[status], 'FAILED' as const, 'CANCELLED' as const]) {
        if (!canTransition(status, next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect([...seen].sort()).toEqual([...JOB_STATUS_VALUES].sort());
  });
});
