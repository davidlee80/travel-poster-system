import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { INITIAL_PLANNER_STATE, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { StepPage } from '../StepPage';

/**
 * 第 5 步「路上怎么走」与 step5-design.png 参考稿的对齐断言。
 *
 * 参考稿的关键结构：航班相关的三个字段各成一张卡（卡的标题就是问句），
 * 「到了当地怎么移动」只含当地方式标签；「自驾计划详情」只在选择自驾后
 * 作为独立组展开。
 *
 * 这个状态（飞行 + 自驾）让三个航班字段、自驾详情与行李字段全部触发，
 * 与设计稿截图的场景一致。
 */
const DESIGN_SCENE: PlannerState = {
  ...INITIAL_PLANNER_STATE,
  answers: {
    trip: {
      destinations: [
        { text: '东京', country: '日本' },
        { text: '京都', country: '日本' },
      ],
    },
    transport: {
      intercity_modes: [
        { code: 'transport.flight', stance: 'PREFER' },
        { code: 'transport.self_drive', stance: 'PREFER' },
      ],
    },
  },
  touched: [],
};

function renderStep5(): string {
  return renderToStaticMarkup(
    <StepPage
      step="05"
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

describe('第 5 步与参考稿对齐', () => {
  it('七个区块按参考稿顺序出现', () => {
    const html = renderStep5();
    const order = [
      '跨城怎么走',
      '航班要求',
      '偏好舱等与座位',
      '更喜欢什么时候出发/抵达？',
      '到了当地怎么移动',
      '自驾计划详情',
      '行李',
    ];
    let cursor = -1;
    for (const title of order) {
      const at = html.indexOf(title);
      expect(at, `区块「${title}」`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('「航班要求」「什么时候出发/抵达」两张卡的字段标题不重复（区块标题即问句）', () => {
    const html = renderStep5();
    /*
     * 002/004 用 `hide_question`：区块标题就是问句，字段标题不重复。
     * 003 的契约问句恰好与组名相同（「偏好舱等与座位」），保留字段标题 —
     * 视觉上与参考稿一致，且不动契约文案。
     */
    expect(html).not.toContain('planner-section__title" id="PV2-05-002-title"');
    expect(html).not.toContain('planner-section__title" id="PV2-05-004-title"');
    expect(html).toContain('planner-section__title" id="PV2-05-003-title"');
    /* 「航班要求」的触发原因与区块 intro 合并，只显示一次 */
    expect(html.match(/转机与过境规则需要提前确认/g) ?? []).toHaveLength(1);
  });

  it('「当地怎么移动」组不含自驾详情字段', () => {
    const html = renderStep5();
    const localBlock = html.slice(html.indexOf('到了当地怎么移动'));
    const selfDriveBlock = html.slice(html.indexOf('自驾计划详情'));
    expect(localBlock.indexOf('到了当地怎么移动')).toBeLessThan(
      html.indexOf('data-field="PV2-05-006"') - html.indexOf('到了当地怎么移动'),
    );
    expect(selfDriveBlock).toContain('data-field="PV2-05-006"');
  });

  it('「避免深夜抵达」带 ⓘ 说明文案', () => {
    const html = renderStep5();
    expect(html).toContain('避免深夜抵达');
    expect(html).toContain('晚于当地 23:00');
  });
});
