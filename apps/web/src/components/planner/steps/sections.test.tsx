import {
  PLANNER_FIELDS,
  PLANNER_FIELD_COUNT,
  PLANNER_STEP_IDS,
  type PlannerFieldId,
  type PlannerStepId,
} from '@tps/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { INITIAL_PLANNER_STATE, fieldsOfStep, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { PrepCenter } from '../PrepCenter';
import { StepPage } from '../StepPage';
import { STEP_SECTIONS } from './sections';

/**
 * 规范 21.1 的阻塞发布门槛在测试里的落点：
 * **九步问卷渲染出的 `data-field` 必须与元数据表一一对应。**
 *
 * ## 为什么用 `renderToStaticMarkup` 而不是 jsdom
 *
 * 这里要断言的是「渲染出来了、且绑定正确」，不是交互行为 —— 交互行为由
 * 状态层的单测（triggers / step-state）覆盖，那一层不需要 DOM。为此引入
 * jsdom + testing-library 两个依赖，换来的只是同一件事的另一种写法，
 * 而 `apps/web` 的 vitest 环境目前是 `node`，改成 jsdom 会让既有 5 个
 * 纯逻辑测试文件都跑在一个不需要的浏览器模拟里。
 *
 * ## 为什么需要多个场景
 *
 * 76 个字段里 36 个是条件触发的，而其中若干**互斥**：预算模式选「总预算」
 * 时不问档次，选「旅行档次」时不问金额区间。一个场景不可能触发全部字段，
 * 因此断言的是「若干场景的并集 ≡ 全部字段」。用一个「全部触发」的假状态
 * 绕过这件事是错的：那会让互斥分支的渲染永远不被测到。
 */

/** 主问卷的 70 个字段。第 10 步的 6 个是 POST_PLAN，由行前准备中心承载（P9-8）*/
const MAIN_FIELD_IDS: readonly PlannerFieldId[] = PLANNER_FIELDS.filter(
  (spec) => spec.level !== 'POST_PLAN',
).map((spec) => spec.field_id);

const MAIN_STEPS: readonly PlannerStepId[] = PLANNER_STEP_IDS.filter((step) => step !== '10');

/** 空状态。恒显示的 40 个字段 + 空状态下条件成立的那些 */
const EMPTY: PlannerState = INITIAL_PLANNER_STATE;

/**
 * 跨境多城、带儿童、自驾、有过敏与健康需求、商务+休闲、总预算。
 *
 * 一次性覆盖附录 B 的 D-01～D-08 全部依赖链。**不是**一份现实的行程 ——
 * 它的用途是让每条链都至少被渲染一次。
 */
const RICH: PlannerState = {
  ...INITIAL_PLANNER_STATE,
  answers: {
    trip: {
      origin: { text: '上海', country: '中国' },
      destination_status: 'CONFIRMED',
      destinations: [
        { text: '东京', country: '日本' },
        { text: '京都', country: '日本' },
      ],
      dates: { start_date: '2026-10-01', end_date: '2026-10-07' },
      date_flexibility: 'FIXED',
      locked_order_types: ['LODGING'],
    },
    profile: { trip_purposes: { values: ['BLEISURE', 'FAMILY'] } },
    travelers: {
      count: 3,
      profiles: [
        { relation: 'SELF', age_band: 'ADULT' },
        { relation: 'PARTNER', age_band: 'ADULT' },
        { relation: 'CHILD', age_band: 'CHILD', age: 6 },
      ],
      child_needs: { values: ['FIXED_NAP'] },
    },
    budget: { mode: 'TOTAL' },
    transport: {
      intercity_modes: [
        { code: 'transport.flight', stance: 'PREFER' },
        { code: 'transport.self_drive', stance: 'PREFER' },
      ],
    },
    lodging: { types: [{ code: 'accommodation.hotel', stance: 'REQUIRE' }] },
    food: { has_allergies: 'YES' },
    interests: {
      tags: ['interest.shopping', 'interest.nightlife', 'interest.food'],
    },
    special: { has_health_or_accessibility_needs: 'YES' },
  },
  touched: ['PV2-01-001'],
};

/** 与 RICH 只差预算模式 —— 「旅行档次」这条互斥分支只有它能触发 */
const TIER: PlannerState = {
  ...RICH,
  answers: { ...RICH.answers, budget: { mode: 'TIER' } },
};

const SCENARIOS: readonly { readonly name: string; readonly state: PlannerState }[] = [
  { name: '空状态', state: EMPTY },
  { name: '跨境多城带儿童自驾', state: RICH },
  { name: '按旅行档次表达预算', state: TIER },
];

/** 渲染一个场景的九步，返回出现过的 field_id */
function renderScenario(state: PlannerState): readonly string[] {
  const snapshot = buildSnapshot(state);
  const found: string[] = [];
  for (const step of MAIN_STEPS) {
    const html = renderToStaticMarkup(
      <StepPage
        step={step}
        active
        state={state}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    for (const match of html.matchAll(/data-field="([^"]+)"/g)) {
      const id = match[1];
      if (id !== undefined) found.push(id);
    }
  }
  return found;
}

/**
 * 渲染行前准备中心，返回出现过的 field_id。
 *
 * 六张卡全部收起 —— 收起状态用 `hidden` 而不是不渲染，因此 `data_field`
 * 仍在 DOM 里。这正是那个设计的理由：规范 21.1 要求 76 个绑定**可被识别**，
 * 而一个折叠起来就消失的绑定过不了那道门槛。
 */
function prepMarkup(): string {
  return renderToStaticMarkup(
    <PrepCenter
      state={RICH}
      snapshot={buildSnapshot(RICH, { planGenerated: true })}
      dispatch={() => undefined}
      registerField={() => undefined}
      openCards={[]}
      onToggleCard={() => undefined}
      planId="plan_test"
    />,
  );
}

function renderPrepCenter(): readonly string[] {
  return [...prepMarkup().matchAll(/data-field="([^"]+)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('区块表与元数据表一致', () => {
  it('每一步的各区块拼起来逐个等于该步的字段（顺序、数量、内容都不许差）', () => {
    /*
     * 逐个相等而不是集合相等：区块划分**不得改变字段顺序** —— 规范每一章给的
     * 是「页面区块顺序」，重排会让「规范说先问日期，界面先问目的地」。
     */
    for (const step of PLANNER_STEP_IDS) {
      const declared = STEP_SECTIONS[step].flatMap((section) => section.fields);
      const expected = fieldsOfStep(step).map((spec) => spec.field_id);
      expect(declared, `第 ${step} 步`).toEqual(expected);
    }
  });

  it('每一步至少有一个区块，且没有空区块', () => {
    for (const step of PLANNER_STEP_IDS) {
      expect(STEP_SECTIONS[step].length, `第 ${step} 步`).toBeGreaterThan(0);
      for (const section of STEP_SECTIONS[step]) {
        expect(section.fields.length, `${step} · ${section.title}`).toBeGreaterThan(0);
      }
    }
  });

  it('区块标题在同一步内不重复 —— 它同时是 React key', () => {
    for (const step of PLANNER_STEP_IDS) {
      const titles = STEP_SECTIONS[step].map((section) => section.title);
      expect(new Set(titles).size, `第 ${step} 步`).toBe(titles.length);
    }
  });
});

describe('九步渲染出全部主问卷字段', () => {
  it('三个场景的并集恰好是 70 个非 POST_PLAN 字段', () => {
    const seen = new Set<string>();
    for (const scenario of SCENARIOS) {
      for (const id of renderScenario(scenario.state)) seen.add(id);
    }

    const missing = MAIN_FIELD_IDS.filter((id) => !seen.has(id));
    const extra = [...seen].filter((id) => !(MAIN_FIELD_IDS as readonly string[]).includes(id));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(seen.size).toBe(MAIN_FIELD_IDS.length);
  });

  it('单次渲染里每个 field_id 只出现一次', () => {
    /*
     * 规范 3.3 禁止合并标识，同样禁止一个字段绑两个容器：Dev Mode 与摘要回跳
     * 都靠 `data-field` 定位，两个同名容器会让回跳滚到其中随机一个。
     */
    for (const scenario of SCENARIOS) {
      const found = renderScenario(scenario.state);
      const duplicated = found.filter((id, index) => found.indexOf(id) !== index);
      expect(duplicated, scenario.name).toEqual([]);
    }
  });

  it('第 10 步的字段一个都不出现在九步里', () => {
    /* 规范 16：行前准备中心不把用户拖回主问卷 */
    for (const scenario of SCENARIOS) {
      const found = renderScenario(scenario.state);
      expect(
        found.filter((id) => id.startsWith('PV2-10-')),
        scenario.name,
      ).toEqual([]);
    }
  });

  it('加上行前准备中心之后，76 个 Field ID 全部可被识别（规范 21.1）', () => {
    /*
     * 这是规范 21.1 那条**阻塞发布**门槛的完整落点：
     * 「V2.1 必须能识别 76 个唯一 Field ID」。
     *
     * 九步覆盖 70 个（非 POST_PLAN），行前准备中心覆盖余下 6 个。
     * 分两处渲染是规范 16 的要求（不把用户拖回主问卷），因此断言也分两段 ——
     * 但**并集必须是 76**，且不能有任何一个 id 出现在两边。
     */
    const inSteps = new Set<string>();
    for (const scenario of SCENARIOS) {
      for (const id of renderScenario(scenario.state)) inSteps.add(id);
    }
    const inPrep = new Set(renderPrepCenter());

    const overlap = [...inPrep].filter((id) => inSteps.has(id));
    expect(overlap).toEqual([]);

    const all = new Set([...inSteps, ...inPrep]);
    const expected = PLANNER_FIELDS.map((spec) => spec.field_id);
    expect(expected.filter((id) => !all.has(id))).toEqual([]);
    expect(all.size).toBe(PLANNER_FIELD_COUNT);
  });

  it('互斥的预算分支各自只在自己的场景里出现', () => {
    /*
     * 这条断言守的是「并集」那条断言的漏洞：如果两个互斥字段**同时**出现在
     * 同一个场景里，并集仍然是 70，测试照样绿 —— 而界面上会同时问
     * 「目标预算范围」和「希望什么档次」，用户不知道该填哪个。
     */
    const total = new Set(renderScenario(RICH));
    const tier = new Set(renderScenario(TIER));
    expect(total.has('PV2-03-003')).toBe(true);
    expect(total.has('PV2-03-004')).toBe(false);
    expect(tier.has('PV2-03-004')).toBe(true);
    expect(tier.has('PV2-03-003')).toBe(false);
  });
});

describe('控件真的渲染出来了', () => {
  it('空数组答案有明确的“无”入口，而不是要求用户先选中再取消', () => {
    const snapshot = buildSnapshot(EMPTY);
    const step7 = renderToStaticMarkup(
      <StepPage
        step="07"
        active
        state={EMPTY}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    const step8 = renderToStaticMarkup(
      <StepPage
        step="08"
        active
        state={EMPTY}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    expect(step7).toContain('没有特殊饮食要求');
    expect(step8).toContain('没有相关活动');
  });

  it('单选卡片渲染成一组 aria-pressed 按钮', () => {
    /*
     * 只断言 `data-field` 存在是不够的：一个空的 `<div data-field>` 也能过。
     * 这条盯住「区块里确实有可操作的控件」。
     */
    const snapshot = buildSnapshot(EMPTY);
    const html = renderToStaticMarkup(
      <StepPage
        step="01"
        active
        state={EMPTY}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    expect(html).toContain('aria-pressed');
    expect(html).toContain('已经确定');
    expect(html).toContain('前后可差 3 天');
  });

  it('三态标签只在选项文字前显示状态图标，并用 aria 属性表达具体含义', () => {
    const snapshot = buildSnapshot(RICH);
    const html = renderToStaticMarkup(
      <StepPage
        step="05"
        active
        state={RICH}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    expect(html).toContain('data-stance="PREFER"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/planner-tag__mark[^>]*>♡<\/span><span class="planner-tag__label">/);
    expect(html).toContain('★ 必须满足');
    expect(html).toContain('× 明确排除');
    expect(html).not.toContain('planner-tag__state');
    expect(html).toMatch(/aria-label="[^"]*当前优先考虑/);
  });

  it('条件分支首次展开时带触发原因（规范 6 的「触发解释」）', () => {
    const snapshot = buildSnapshot(RICH);
    const html = renderToStaticMarkup(
      <StepPage
        step="08"
        active
        state={RICH}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    expect(html).toContain('因为出发地与目的地不在同一个国家');
  });

  it('Dev Mode 显示规范 21.1 要求的七项', () => {
    const state: PlannerState = { ...RICH, devMode: true };
    const snapshot = buildSnapshot(state);
    const html = renderToStaticMarkup(
      <StepPage
        step="01"
        active
        state={state}
        snapshot={snapshot}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />,
    );
    for (const label of [
      'Field ID',
      'API Key',
      'Runtime Type',
      'Priority',
      'Blocking',
      'Trigger Source',
      'Field State',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('planner_profile.trip.origin');
  });
});

/**
 * 附录 C 的可访问性检查项（阻塞发布）：**键盘 / ARIA / 状态文本**。
 *
 * 这里只做能自动化的那一半。手工那一半（用键盘从第 1 步走到第 9 步、
 * 用屏读器听一遍状态）不在单测的能力范围内，而自动化能覆盖的三件事
 * 恰好是最容易在改版中回退的三件：无名按钮、没有 label 的控件、
 * 只用颜色表达的状态。
 */
describe('可访问性的可自动化部分（附录 C）', () => {
  /** 渲染全部九步 + 准备中心，拿到一份完整的标记 */
  function allMarkup(): string {
    const snapshot = buildSnapshot(RICH, { planGenerated: true });
    const pages = MAIN_STEPS.map((step) =>
      renderToStaticMarkup(
        <StepPage
          step={step}
          active
          state={RICH}
          snapshot={snapshot}
          dispatch={() => undefined}
          onPrev={null}
          onNext={null}
          nextLabel={null}
          registerField={() => undefined}
        />,
      ),
    );
    return [...pages, prepMarkup()].join('\n');
  }

  it('每个按钮都有可读的名字（文字或 aria-label）', () => {
    /*
     * 一个只有图标的按钮（↑ ↓ ✕ ⋯）在屏读器里念作「按钮」——
     * 而排序控件正好全是这种。因此这条断言盯的是：按钮内要么有非符号文字，
     * 要么有 aria-label。
     */
    const nameless: string[] = [];
    for (const match of allMarkup().matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const attrs = match[1] ?? '';
      const inner = (match[2] ?? '').replace(/<[^>]*>/g, '').trim();
      if (attrs.includes('aria-label=')) continue;
      /* 去掉纯符号后还剩内容才算有名字 */
      const words = inner.replace(/[↑↓✕＋−×✓○▴▾⋯·／/\s]/g, '');
      if (words.length === 0) nameless.push(match[0].slice(0, 90));
    }
    expect(nameless).toEqual([]);
  });

  it('每个 label 都指向一个真实存在的控件 id', () => {
    /*
     * `htmlFor` 指向一个不存在的 id 等于没有 label —— 而它看起来完全正常
     * （文字照样显示、点击照样不聚焦，而「点标签不聚焦」很少有人试）。
     */
    const markup = allMarkup();
    const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const dangling = [...markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((target) => target !== undefined && !ids.has(target));
    expect(dangling).toEqual([]);
  });

  it('三态状态有可访问名称，字段头只显示“必须满足”徽标', () => {
    const markup = allMarkup();
    expect(markup).toMatch(/planner-tag--prefer[^>]*aria-label="[^"]*当前优先考虑/);
    expect(markup).toContain('planner-badge planner-badge--hard">必须满足');
    expect(markup).not.toContain('planner-badge--fact');
  });

  it('折叠区用 aria-expanded 而不是只换一个图标', () => {
    expect(prepMarkup()).toMatch(/aria-expanded="(true|false)"/);
  });

  it('计数器与滑块的当前值可被朗读', () => {
    /* 按了加号没有任何朗读反馈时，屏读用户无法确认自己改到了几 */
    const markup = allMarkup();
    expect(markup).toMatch(/<output[^>]*aria-live="polite"/);
    expect(markup).toMatch(/aria-valuetext="[^"]+"/);
  });
});
