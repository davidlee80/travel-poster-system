import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '@/lib/planner/step-state';
import { ENTRY_ROUTE_VALUES, INITIAL_PLANNER_STATE, plannerReducer } from '@/lib/planner/state';

import { StepNav } from './StepNav';

const steps = ['01', '02', '03', '04', '05', '06', '07', '08', '09'] as const;

function renderNav(entrySelected: boolean): string {
  return renderToStaticMarkup(
    <StepNav
      activeStep="00"
      snapshot={buildSnapshot(INITIAL_PLANNER_STATE)}
      onJump={() => undefined}
      open={false}
      planGenerated={false}
      entrySelected={entrySelected}
    />,
  );
}

describe('第 0 步选择解锁导航', () => {
  it('未选择时禁用第 1～9 步，保留第 0 步并说明原因', () => {
    const html = renderNav(false);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(10);
    expect(buttons[0]).not.toContain('disabled');
    for (const button of buttons.slice(1)) {
      expect(button).toContain('disabled=""');
      expect(button).toContain('aria-describedby="planner-entry-required"');
    }
    expect(html).toContain('请先选一张卡片并点击「下一步」');
  });

  it('仅选卡片仍锁定，点下一步确认后才解锁', () => {
    const selected = plannerReducer(INITIAL_PLANNER_STATE, { type: 'setEntryRoute', route: 'plan' });
    /* 只选卡片，未确认 → 仍不能跳到第 1-9 步 */
    expect(plannerReducer(selected, { type: 'goToStep', step: '01' })).toBe(selected);
    /* 确认后可以跳 */
    const confirmed = plannerReducer(selected, { type: 'confirmEntry' });
    expect(confirmed.entryConfirmed).toBe(true);
    expect(plannerReducer(confirmed, { type: 'goToStep', step: '01' }).activeStep).toBe('01');
  });

  it('未选卡片时 confirmEntry 是 no-op', () => {
    expect(plannerReducer(INITIAL_PLANNER_STATE, { type: 'confirmEntry' })).toBe(
      INITIAL_PLANNER_STATE,
    );
  });

  it('改选卡片不重置确认位', () => {
    const selected = plannerReducer(INITIAL_PLANNER_STATE, { type: 'setEntryRoute', route: 'plan' });
    const confirmed = plannerReducer(selected, { type: 'confirmEntry' });
    const reselected = plannerReducer(confirmed, { type: 'setEntryRoute', route: 'explore' });
    expect(reselected.entryRoute).toBe('explore');
    expect(reselected.entryConfirmed).toBe(true);
  });

  it('选择后所有导航按钮可用', () => {
    expect(renderNav(true)).not.toContain('disabled');
    expect(renderNav(true)).not.toContain('planner-entry-required');
  });

  it.each(steps)('未选择时其他入口也不能跳到第 %s 步', (step) => {
    expect(plannerReducer(INITIAL_PLANNER_STATE, { type: 'goToStep', step })).toBe(
      INITIAL_PLANNER_STATE,
    );
  });

  it.each(ENTRY_ROUTE_VALUES)('选择 %s 卡片并确认后可自由跳转，返回第 0 步仍保留选择', (route) => {
    const selected = plannerReducer(INITIAL_PLANNER_STATE, { type: 'setEntryRoute', route });
    const confirmed = plannerReducer(selected, { type: 'confirmEntry' });
    for (const step of steps) {
      const navigated = plannerReducer(confirmed, { type: 'goToStep', step });
      expect(navigated.activeStep).toBe(step);
      expect(plannerReducer(navigated, { type: 'goToStep', step: '00' }).entryRoute).toBe(route);
    }
  });

  it('恢复未选择的草稿时回到第 0 步并保留答案', () => {
    const draft = {
      ...INITIAL_PLANNER_STATE,
      activeStep: '03' as const,
      answers: { travelers: { count: 2 } },
    };
    const restored = plannerReducer(INITIAL_PLANNER_STATE, { type: 'restore', state: draft });
    expect(restored.activeStep).toBe('00');
    expect(restored.answers).toEqual(draft.answers);
  });

  it('恢复已确认的草稿时保留步骤，重置后重新锁定', () => {
    const draft = {
      ...INITIAL_PLANNER_STATE,
      activeStep: '03' as const,
      entryRoute: 'plan' as const,
      entryConfirmed: true,
    };
    const restored = plannerReducer(INITIAL_PLANNER_STATE, { type: 'restore', state: draft });
    expect(restored).toEqual(draft);
    const reset = plannerReducer(restored, { type: 'reset' });
    expect(reset.entryRoute).toBeNull();
    expect(reset.entryConfirmed).toBe(false);
    expect(plannerReducer(reset, { type: 'goToStep', step: '01' }).activeStep).toBe('00');
  });
});
