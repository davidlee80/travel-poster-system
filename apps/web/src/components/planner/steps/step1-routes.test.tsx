import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PlannerConfigProvider } from '@/components/planner/PlannerConfigProvider';
import { StepPage } from '@/components/planner/StepPage';
import { INITIAL_PLANNER_STATE, type EntryRoute, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { STEP1_CONTENT_BY_ROUTE } from '@/lib/planner/entry-routes';

/**
 * 四条路线的第 1 步渲染冒烟。
 *
 * `entry-routes.test.ts` 守住内容表的**数据**正确性，这里守住它真的
 * **能渲染**：占位字段（RT-*）走过 FieldControl 岔路、契约字段仍走
 * 原管线、页头文案按路线切换。渲染不出来的表现是页面上一整块空白，
 * 而那只靠数据测试发现不了。
 */

function renderStep1(route: EntryRoute | null, answers: PlannerState['answers'] = {}): string {
  const state: PlannerState = { ...INITIAL_PLANNER_STATE, entryRoute: route, answers };
  return renderToStaticMarkup(
    <PlannerConfigProvider>
      <StepPage
        step="01"
        active
        state={state}
        snapshot={buildSnapshot(state)}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />
    </PlannerConfigProvider>,
  );
}

/** 某条路线的内容表声明的字段，每一个都该在 HTML 里出现 */
function expectFields(html: string, route: 'explore' | 'destination' | 'time'): void {
  const content = STEP1_CONTENT_BY_ROUTE[route];
  if (content === undefined) throw new Error('unreachable');
  for (const section of content.sections) {
    expect(html, `缺区块「${section.title}」`).toContain(section.title);
    for (const fieldId of section.fields) {
      expect(html, `缺字段 ${fieldId}`).toContain(`data-field="${fieldId}"`);
    }
  }
}

describe('第 1 步按路线渲染', () => {
  it('explore：占位字段渲染出控件，不问目的地与日期', () => {
    const html = renderStep1('explore');
    expectFields(html, 'explore');
    /* 兴趣六宫格真实渲染成可点选项 */
    expect(html).toContain('休息放松');
    expect(html).toContain('亲近自然');
    /* 页头按路线覆盖 */
    expect(html).toContain('先不决定去哪');
    expect(html).not.toContain('已经订好的部分');
  });

  it('destination：契约日期字段仍走原管线（值写进 trip.dates）', () => {
    const html = renderStep1('destination');
    expectFields(html, 'destination');
    expect(html).toContain('假期留出来了');
    expect(html).toContain('3 小时以内');
    /* 目的地列表（explore/time 的事）不出现 */
    expect(html).not.toContain('备选目的地');
  });

  it('time：时间窗口的三段切换 + 候选月/区间随模式显隐', () => {
    const html = renderStep1('time');
    expectFields(html, 'time');
    expect(html).toContain('心里已经有了远方');
    expect(html).toContain('几个候选月');
    expect(html).toContain('等合适价格');
    /*
     * 默认 mode 未选 → months/range 两个部件都被 requires 藏起。
     * 这是「值保留」语义的一部分：藏起来不等于清掉。
     */
    expect(html).not.toContain('候选月份（含年份');

    /*
     * 选了「几个候选月」之后，月份部件展开。requires 的判定链
     * （partVisibleByKey → route_time.window.mode）只有这里走到。
     */
    const expanded = renderStep1('time', {
      route_time: { window: { mode: 'months', months: ['2026-10'] } },
    } as never);
    expect(expanded).toContain('候选月份（含年份');
    expect(expanded).toContain('2026-10');
  });

  it('plan：保持现状（全量五区块，无占位字段）', () => {
    const html = renderStep1('plan');
    expect(html).toContain('已经订好的部分');
    expect(html).toContain('目的地 / 备选目的地');
    expect(html).not.toContain('data-field="RT-');
  });

  it('未选路线（直达第 1 步的兜底）与 plan 一致', () => {
    const html = renderStep1(null);
    expect(html).toContain('已经订好的部分');
    expect(html).not.toContain('data-field="RT-');
  });
});
