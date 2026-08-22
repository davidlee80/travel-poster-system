import { describe, expect, it } from 'vitest';

import { dialogViewFor, type GenerationPhase } from './generation-dialog.js';

/**
 * 生成等待弹层的视图推导。
 *
 * 三条断言值得单列，各自对应一种用户会当成故障的显示：
 *   - **`ready` 时进度条必须满格**。`ready` 触发于 `SAVING_PLAN`（21.2 的 T1），
 *     后端此刻的 `progress` 可能才 60 —— 直接用它会让「行程已生成」旁边写着
 *     「已完成 60%」，用户会以为还没好。
 *   - **提交阶段的 percent 是 null 而不是 0**。0% 的进度条读起来是「卡住了」。
 *   - **生成中不可关闭**。轮询挂在 Planner 上，关掉弹层它继续跑，但用户再也
 *     看不到结果 —— 比不给关闭按钮更糟。
 */

describe('idle', () => {
  it('不显示弹层', () => {
    expect(dialogViewFor({ kind: 'idle' })).toBeNull();
  });
});

describe('submitting', () => {
  const view = dialogViewFor({ kind: 'submitting' });

  it("进度是 'indeterminate' 而不是 0", () => {
    // 0% 的静止进度条读起来是「卡住了」；这一档要跑马灯
    expect(view?.percent).toBe('indeterminate');
  });

  it('不可关闭', () => {
    expect(view?.dismissible).toBe(false);
  });

  it('两行文字都有内容', () => {
    expect(view?.lines).toHaveLength(2);
    expect(view?.lines.every((line) => line.length > 0)).toBe(true);
  });
});

describe('generating', () => {
  function generating(progress: number, message = '正在生成行程'): GenerationPhase {
    return { kind: 'generating', progress, message };
  }

  it('第一行直接用后端的 message，不自己拼', () => {
    /*
     * 13.2 的 message 是后端按 16.1 的当前状态给的用户文案。前端另写一套
     * 必然与它漂移，而漂移的表现是「进度条走到 80% 了，文字还停在正在检索」。
     */
    expect(dialogViewFor(generating(42, '正在校验并修复行程'))?.lines[0]).toBe(
      '正在校验并修复行程',
    );
  });

  it('第二行是稳定提示，不随进度变', () => {
    const a = dialogViewFor(generating(10))?.lines[1];
    const b = dialogViewFor(generating(90))?.lines[1];
    expect(a).toBe(b);
    expect(a).toContain('不要关闭');
  });

  it('进度原样透出（取整）', () => {
    expect(dialogViewFor(generating(42))?.percent).toBe(42);
    expect(dialogViewFor(generating(42.6))?.percent).toBe(43);
  });

  it('越界的进度被收进 0～100', () => {
    /*
     * 16.2 保证单调不减，但保证不了上下界。120 会让填充块溢出圆角容器、
     * 负数会让它反向 —— 而那种缺陷在 CSS 层面看不出是数据问题。
     */
    expect(dialogViewFor(generating(120))?.percent).toBe(100);
    expect(dialogViewFor(generating(-5))?.percent).toBe(0);
    expect(dialogViewFor(generating(Number.NaN))?.percent).toBe(0);
  });

  it('不可关闭', () => {
    expect(dialogViewFor(generating(50))?.dismissible).toBe(false);
  });
});

describe('ready', () => {
  const view = dialogViewFor({ kind: 'ready', planId: 'plan-1' });

  it('进度条满格，而不是后端此刻的百分比', () => {
    expect(view?.percent).toBe(100);
  });

  it('带上 planId 供跳转', () => {
    expect(view?.planId).toBe('plan-1');
    expect(view?.tone).toBe('done');
  });

  it('可以关闭', () => {
    expect(view?.dismissible).toBe(true);
  });

  it('明确说配图还在后台生成', () => {
    // 不说的话用户点进去看到占位图会当成生成失败（T1 放人走，素材在 T2）
    expect(view?.lines[1]).toContain('后台');
  });
});

describe('error', () => {
  it('第一行是后端给的错误文案，不被前端的「生成失败」盖掉', () => {
    const view = dialogViewFor({
      kind: 'error',
      message: '请放宽部分条件后重试。',
      retryable: false,
    });
    expect(view?.lines[0]).toBe('请放宽部分条件后重试。');
    expect(view?.tone).toBe('error');
  });

  it('第二行按可重试与否给不同指引', () => {
    const retryable = dialogViewFor({ kind: 'error', message: 'x', retryable: true })?.lines[1];
    const fatal = dialogViewFor({ kind: 'error', message: 'x', retryable: false })?.lines[1];

    expect(retryable).toContain('重试');
    expect(fatal).not.toBe(retryable);
  });

  it('可以关闭，且**完全不画**进度条', () => {
    /*
     * percent 为 null 是「不显示」，与 submitting 的 'indeterminate'
     * （显示跑马灯）是两件事。两者曾共用 null，结果失败弹层上挂着一根
     * 还在来回扫的跑马灯 —— 读起来像「仍在工作」，与实际状态正好相反。
     */
    const view = dialogViewFor({ kind: 'error', message: 'x', retryable: true });
    expect(view?.dismissible).toBe(true);
    expect(view?.percent).toBeNull();
  });

  it('失败与提交中的 percent 语义不同（回归守卫）', () => {
    expect(dialogViewFor({ kind: 'error', message: 'x', retryable: true })?.percent).toBeNull();
    expect(dialogViewFor({ kind: 'submitting' })?.percent).toBe('indeterminate');
  });
});
