import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { INITIAL_PLANNER_STATE, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { StepPage } from '../StepPage';

/**
 * 第 6 步「住得更舒服」与 step6-design.png 参考稿的对齐断言。
 *
 * 参考稿的关键结构：五张卡按「住什么类型 → 房间怎么配 → 每晚预算与位置取舍 →
 * 星级、设施与入住 → 睡眠和入住有什么硬要求？」排列；「睡眠和入住有什么硬要求？」
 * 独占一张卡（卡的标题就是问句，check 部件不再重复标签）。
 *
 * 这个状态（已设房间数 + 偏好酒店）让房型 Repeater 与星级品牌字段全部触发，
 * 与设计稿截图的场景一致。
 */
const DESIGN_SCENE: PlannerState = {
  ...INITIAL_PLANNER_STATE,
  answers: {
    lodging: {
      types: ['accommodation.hotel'],
      rooms_count: 1,
    },
  },
  touched: [],
};

function renderStep6(): string {
  return renderToStaticMarkup(
    <StepPage
      step="06"
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

describe('第 6 步与参考稿对齐', () => {
  it('五个区块按参考稿顺序出现', () => {
    const html = renderStep6();
    const order = [
      '住什么类型',
      '房间怎么配',
      '每晚预算与位置取舍',
      '星级、设施与入住',
      '睡眠和入住有什么硬要求？',
    ];
    let cursor = -1;
    for (const title of order) {
      const at = html.indexOf(title);
      expect(at, `区块「${title}」`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('「睡眠和入住有什么硬要求？」独占一张卡，部件不重复标签', () => {
    const html = renderStep6();
    const sleepBlock = html.slice(html.indexOf('睡眠和入住有什么硬要求？'));
    expect(sleepBlock).toContain('data-field="PV2-06-008"');
    /* 部件 label「睡眠与入住要求」已移除 —— 区块标题就是问句 */
    expect(html).not.toContain('睡眠与入住要求');
  });

  it('「星级、设施与入住」组不含睡眠要求字段', () => {
    const html = renderStep6();
    const starBlock = html.indexOf('星级、设施与入住');
    const sleepBlock = html.indexOf('睡眠和入住有什么硬要求？');
    const sleepField = html.indexOf('data-field="PV2-06-008"');
    expect(starBlock).toBeGreaterThan(-1);
    expect(sleepBlock).toBeGreaterThan(starBlock);
    expect(sleepField).toBeGreaterThan(sleepBlock);
  });

  it('住宿类型是两段式标签（要 / 不要），不渲染三态图例', () => {
    const html = renderStep6();
    expect(html).toContain('data-field="PV2-06-001"');
    expect(html).not.toContain('planner-stance-guide');
  });

  it('选项按钮带图标（参考稿的 🏨 住酒店…）', () => {
    const html = renderStep6();
    expect(html).toContain('住酒店');
    expect(html).toContain('planner-choice__icon');
  });

  it('房间计数器与「需要几间房？」问句在房间配置卡内', () => {
    const html = renderStep6();
    const roomBlock = html.slice(html.indexOf('房间怎么配'));
    expect(roomBlock).toContain('需要几间房？');
    expect(roomBlock).toContain('planner-counter');
  });
});
