import { TEMPLATE_ID_VALUES, TRAVEL_PLAN_FIXTURES, type TemplateId } from '@tps/schemas';
import { buildDailyPoster, buildFullPlan } from '@tps/presentation';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OVERFLOW_PRIORITY, OVERFLOW_SLOT_NAME } from './overflow-guards';
import { templateComponent } from './registry';

/**
 * 每个样式套件都能渲出完整产物（R-85 P2）。
 *
 * ## 为什么 suite-invariants 不够
 *
 * 那一组验的是**文件结构**：token 齐不齐、类名有没有相交、有没有 relaxed。
 * 全部通过也不能说明组件跑得起来 —— 一个 ViewModel 字段写错名字、
 * 一个 `undefined.map()`，文件结构照样合规。
 *
 * 这一组渲染真实 ViewModel（由 fixture 与 `@tps/presentation` 生成），
 * 断言产物里该有的东西都在。**换套件不该丢内容** —— 两套的排版可以完全不同，
 * 但同一份计划的信息必须都渲出来。
 *
 * ## 用 renderToStaticMarkup 而不是 jsdom
 *
 * web 侧没有 jsdom 依赖，而这里要验的是「产物里有没有这段文字」，
 * 不需要 DOM API。与 `components/planner/config-driven.test.tsx` 同一处理。
 */

/** 三天的 fixture：够覆盖多日、又不至于让 HTML 大到难查 */
const plan = TRAVEL_PLAN_FIXTURES.sevenDays();

/**
 * 取组件并断言它存在。
 *
 * `templateComponent` 刻意返回可空（未注册的套件让路由走 404，而不是
 * 静默回退到默认套件）。测试里那是不应发生的 —— 遍历的就是已注册列表，
 * 因此报错而不是用 `!` 糊过去。
 */
function componentOf(templateId: TemplateId, pageType: 'DAILY_POSTER' | 'FULL_PLAN') {
  const Component = templateComponent(templateId, pageType);
  if (Component === null) throw new Error(`套件 ${templateId} 没有 ${pageType} 组件`);
  return Component;
}

function dailyMarkup(templateId: TemplateId, dayNumber = 1): string {
  const Component = componentOf(templateId, 'DAILY_POSTER');
  const { viewModel } = buildDailyPoster({ plan, dayNumber, templateId });
  return renderToStaticMarkup(<Component viewModel={viewModel} />);
}

function fullMarkup(templateId: TemplateId): string {
  const Component = componentOf(templateId, 'FULL_PLAN');
  const { viewModel } = buildFullPlan({ plan, templateId });
  return renderToStaticMarkup(<Component viewModel={viewModel} />);
}

describe('套件渲染产物', () => {
  it.each([...TEMPLATE_ID_VALUES])('%s 的每日页渲出全部区块的内容', (templateId) => {
    const { viewModel } = buildDailyPoster({ plan, dayNumber: 1, templateId });
    const html = dailyMarkup(templateId);

    /*
     * 逐段验内容而不是验类名：类名是各套件自己的（守卫要求它们不相交），
     * 而**内容**是两套必须一致的东西。
     */
    expect(html, '缺标题').toContain(viewModel.header.title);
    expect(html, '缺目的地').toContain(viewModel.header.destination);

    for (const item of viewModel.schedule) {
      expect(html, `缺行程条目「${item.title}」`).toContain(item.title);
    }
    for (const card of viewModel.food_cards) {
      expect(html, `缺美食「${card.name}」`).toContain(card.name);
    }
    for (const spot of viewModel.photo_spots) {
      expect(html, `缺机位「${spot.name}」`).toContain(spot.name);
    }
    for (const entry of viewModel.must_do) {
      expect(html, `缺必做「${entry}」`).toContain(entry);
    }
    for (const tip of viewModel.transport_tips) {
      expect(html, '缺交通提示').toContain(tip.text);
    }

    // 合计金额不可丢：它的守卫优先级与行程条目同为 80（金额不可截断）
    expect(html, '缺预算合计').toContain(viewModel.budget.total_text);
  });

  it.each([...TEMPLATE_ID_VALUES])('%s 的每日页带齐根元素上的四个 data 属性', (templateId) => {
    /*
     * `data-template` 是 token 作用域的锚点（`[data-template='X']`），
     * `data-variant` 是 17.3 第 4 轮的开关，两者缺一样式就会静默失效。
     * `data-page-type` / `data-day` 供排查用。
     */
    const html = dailyMarkup(templateId, 2);

    expect(html).toContain(`data-template="${templateId}"`);
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('data-page-type="DAILY_POSTER"');
    expect(html).toContain('data-day="2"');
  });

  it.each([...TEMPLATE_ID_VALUES])('%s 的每日页标注了全部溢出守卫槽位', (templateId) => {
    /*
     * 17.3 的溢出检测只看带 `data-overflow-guard` 的元素。套件漏标某个槽位的
     * 后果是那一处**永远不会被判为溢出**，于是降级链跳过它 ——
     * 不报错，只是那一处的文字在长内容下直接溢出到画布外。
     */
    const html = dailyMarkup(templateId);

    for (const slot of Object.keys(OVERFLOW_PRIORITY) as (keyof typeof OVERFLOW_PRIORITY)[]) {
      const name = OVERFLOW_SLOT_NAME[slot];
      expect(html, `${templateId} 漏标守卫槽位 ${name}`).toContain(
        `data-overflow-guard="${name}"`,
      );
    }
  });

  it.each([...TEMPLATE_ID_VALUES])('%s 读了 compact 与 variant 两个开关', (templateId) => {
    /*
     * 17.3 的两个开关：
     *   compact  → 改用 `*_compact` 文案（第 2 轮）
     *   variant  → 根元素上的属性变（第 4 轮靠 CSS 选它）
     *
     * **不能断言「compact 必然改变产物」。** 第一版这么写了，结果两套套件
     * 都红 —— 而 ink_paper 是既有代码，那就不可能是新套件的错。
     * 真因是 fixture 的文案本来就短于压缩阈值，`toCompact` 不截，
     * 于是 `title_compact === title`。那是正确行为，不是缺陷。
     *
     * 因此改成验「开关真的被读了」：压缩文案必须出现在产物里（相同时也成立），
     * 而 `variant` 必须落到根元素上。后一条是可以失败的 ——
     * 忽略 `variant` 的组件过不了。
     */
    const Component = componentOf(templateId, 'DAILY_POSTER');
    const { viewModel } = buildDailyPoster({ plan, dayNumber: 1, templateId });

    const compact = renderToStaticMarkup(<Component viewModel={viewModel} compact />);
    const relaxed = renderToStaticMarkup(<Component viewModel={viewModel} variant="relaxed" />);

    expect(compact, 'compact 没有用压缩标题').toContain(viewModel.header.title_compact);
    expect(compact, 'compact 没有用压缩摘要').toContain(viewModel.daily_summary_compact);
    expect(relaxed, 'relaxed 没有落到根元素上').toContain('data-variant="relaxed"');
  });

  it.each([...TEMPLATE_ID_VALUES])('%s 的 hideBelowPriority 真的隐藏低优先级条目', (templateId) => {
    /*
     * 17.3 第 3 轮：从低优先级开始隐藏。取 60 —— 按 OVERFLOW_PRIORITY，
     * 这会隐藏 photoSpotCard(50) 与两类 tip(30)，而保留 foodCard(60)。
     */
    const Component = componentOf(templateId, 'DAILY_POSTER');
    const { viewModel } = buildDailyPoster({ plan, dayNumber: 1, templateId });
    const html = renderToStaticMarkup(
      <Component viewModel={viewModel} hideBelowPriority={60} />,
    );

    expect(html, 'foodCard(60) 应当保留').toContain(
      `data-overflow-guard="${OVERFLOW_SLOT_NAME.foodCard}"`,
    );
    expect(html, 'photoSpotCard(50) 应当被隐藏').not.toContain(
      `data-overflow-guard="${OVERFLOW_SLOT_NAME.photoSpotCard}"`,
    );
    expect(html, 'transportTip(30) 应当被隐藏').not.toContain(
      `data-overflow-guard="${OVERFLOW_SLOT_NAME.transportTip}"`,
    );
  });

  it.each([...TEMPLATE_ID_VALUES])('%s 的全览页渲出概览与每一天', (templateId) => {
    const { viewModel } = buildFullPlan({ plan, templateId });
    const html = fullMarkup(templateId);

    expect(html).toContain(`data-template="${templateId}"`);
    expect(html).toContain('data-page-type="FULL_PLAN"');
    expect(html, '缺概览标题').toContain(viewModel.overview.title);
    expect(html, '缺合计预算').toContain(viewModel.overview.total_budget_text);

    for (const day of viewModel.days) {
      // 锚点 id 供索引跳转用，缺了导航就是死链
      expect(html, `缺第 ${day.day_number} 天的锚点`).toContain(`id="day-${day.day_number}"`);
      expect(html, `缺第 ${day.day_number} 天的标题`).toContain(day.header.title);
    }
  });

  it('两套套件的产物真的不一样（否则「换样式」没有发生）', () => {
    /*
     * 这条在只有一套时无从写起，现在两套了才有意义。
     *
     * 比 HTML 而不是比截图：截图基线在 Linux CI 上拍（门禁 #33），
     * 而这里要的只是「排版结构不同」这个最低保证。
     */
    const [first, second] = TEMPLATE_ID_VALUES;
    expect(TEMPLATE_ID_VALUES.length, '本条需要至少两套套件').toBeGreaterThanOrEqual(2);

    expect(dailyMarkup(first)).not.toBe(dailyMarkup(second));
    expect(fullMarkup(first)).not.toBe(fullMarkup(second));
  });
});
