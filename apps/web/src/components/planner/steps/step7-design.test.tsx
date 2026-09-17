import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { INITIAL_PLANNER_STATE, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { StepPage } from '../StepPage';

/**
 * 第 7 步「吃好也玩好」与 step7-design.png 参考稿的对齐断言。
 *
 * 参考稿的关键结构：五个区块按「想吃什么 → 过敏与安全 → 怎么吃 → 想玩什么 →
 * 购物与退税」排列；选项按钮带语义色图标（餐饮体验、饮食方式、过敏三选、
 * 怎么吃、兴趣主题均为带图标的选项按钮）。
 */
const DESIGN_SCENE: PlannerState = {
  ...INITIAL_PLANNER_STATE,
  answers: {
    /* 兴趣含购物 → 触发「购物与退税」区块（D-01 之外的 optIns 条件链） */
    interests: { tags: ['interest.shopping'] },
  },
  touched: [],
};

function renderStep7(): string {
  return renderToStaticMarkup(
    <StepPage
      step="07"
      active
      state={DESIGN_SCENE}
      snapshot={buildSnapshot(DESIGN_SCENE)}
      dispatch={() => undefined}
      onPrev={null}
      onNext={null}
      nextLabel={null}
      registerField={() => undefined}
    />,
  );
}

describe('第 7 步与参考稿对齐', () => {
  it('五个区块按参考稿顺序出现', () => {
    const html = renderStep7();
    const order = ['想吃什么', '过敏与安全', '怎么吃', '想玩什么', '购物与退税'];
    let cursor = -1;
    for (const title of order) {
      const at = html.indexOf(title);
      expect(at, `区块「${title}」`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('餐饮体验选项渲染图标（当地特色 / Fine Dining / 街头美食…）', () => {
    const html = renderStep7();
    const foodBlock = html.slice(html.indexOf('想吃什么'), html.indexOf('过敏与安全'));
    expect(foodBlock).toContain('当地特色');
    expect(foodBlock).toContain('Fine Dining');
    expect(foodBlock).toContain('planner-choice__icon');
  });

  it('饮食方式选项渲染图标（素食 / 清真 / 不吃辣…）', () => {
    const html = renderStep7();
    expect(html).toContain('素食');
    expect(html).toContain('清真');
    expect(html).toContain('不吃辣');
  });

  it('过敏与安全渲染三选按钮（没有 / 有 / 不确定）', () => {
    const html = renderStep7();
    const block = html.slice(html.indexOf('过敏与安全'), html.indexOf('怎么吃'));
    expect(block).toContain('data-field="PV2-07-003"');
    expect(block).toContain('没有');
    expect(block).toContain('不确定');
  });

  it('怎么吃渲染预算与排队选项（普通为主 / 愿意提前预约…）', () => {
    const html = renderStep7();
    const block = html.slice(html.indexOf('怎么吃'), html.indexOf('想玩什么'));
    expect(block).toContain('普通为主');
    expect(block).toContain('品质餐厅优先');
    expect(block).toContain('愿意提前预约');
  });

  it('想玩什么渲染兴趣选项并带图标（历史与人文 / 自然风光…）', () => {
    const html = renderStep7();
    const block = html.slice(html.indexOf('想玩什么'));
    expect(block).toContain('data-field="PV2-07-006"');
    expect(block).toContain('planner-choice__icon');
  });
});
