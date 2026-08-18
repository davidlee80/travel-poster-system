import { createCounter, createHistogram } from '@tps/observability';
import { RENDER_ROUNDS } from '@tps/presentation';
import type { TemplateId } from '@tps/schemas';

/**
 * 渲染质量指标（TP-5-01，设计稿 21.3）。
 *
 * 这三项在 P1～P4 一直缺失，而它们恰好是**验收标准 5 与 9 的唯一度量**：
 * 门禁 #9 要求 `travel_render_degraded_total = 0`、门禁 #5 要求
 * `travel_icon_load_failure_total` 恒为 0。没有它们时这两条只能靠人看截图。
 */

/** 页面类型。与 run-export 的日志字段取值一致，便于指标与日志对照 */
export type RenderPageType = 'day' | 'full';

/** 页面类型 → 模板 ID。12.2 的两个模板与两种页面一一对应 */
export const TEMPLATE_BY_PAGE_TYPE: Record<RenderPageType, TemplateId> = {
  day: 'travel_infographic_v1',
  full: 'travel_full_plan_v1',
};

/**
 * 21.3 的 `travel_render_overflow_rounds`：17.3 的重渲染轮次分布。
 *
 * 桶就是四轮本身加一个 0（首轮即通过时轮次为 1，因此 0 桶恒空 ——
 * 留着它是为了让「桶边界 = 轮次定义」在读图时一目了然）。
 * P95 贴到 3～4 说明模板的默认版式对真实内容普遍偏紧，
 * 该改模板而不是继续靠降级兜。
 */
export const renderOverflowRounds = createHistogram({
  name: 'travel_render_overflow_rounds',
  help: '17.3 重渲染轮次（1 = 首轮即无溢出）',
  labelNames: ['template_id', 'page_type'],
  buckets: Array.from({ length: RENDER_ROUNDS.length + 1 }, (_, i) => i),
});

/**
 * 21.3 的 `travel_render_degraded_total`：降级产物占比的分子。
 *
 * 标签用 `reason_code` 而不是设计稿的 `reason`：白名单里已有前者，
 * 而值确实是码（`RENDER_OVERFLOW_UNRESOLVED` 等 13.7 的错误码）
 * 而不是自由文本 —— 自由文本作标签值会让基数不可控。
 */
export const renderDegradedTotal = createCounter({
  name: 'travel_render_degraded_total',
  help: '降级产物计数（四轮后仍有溢出等）',
  labelNames: ['reason_code'],
});

/**
 * 21.3 的 `travel_icon_load_failure_total`（验收标准 5，期望恒为 0）。
 *
 * ## 采集点为什么在渲染器里
 *
 * 9.1 把图标内联进构建产物，因此运行期没有「加载」这个动作 ——
 * 唯一可能的失败是 ViewModel 里出现了清单外的图标引用，而它的表现是
 * 模板渲染出一个带 `data-icon-missing` 的占位方框（见 web 的 Icon.tsx）。
 * 那个属性只存在于渲染后的 DOM 里，因此只有开着浏览器的这一侧能数它。
 *
 * 换句话说：这个指标度量的不是网络失败，而是**契约漂移** ——
 * 新增图标键时漏配映射。它恒为 0 才说明 19 个键的映射是完整的。
 */
export const iconLoadFailureTotal = createCounter({
  name: 'travel_icon_load_failure_total',
  help: '渲染页面中未能解析的图标引用数（验收标准 5，期望恒为 0）',
});

/** 一次页面渲染的质量观测 */
export function recordRenderQuality(input: {
  readonly pageType: RenderPageType;
  readonly round: number;
  readonly degraded: boolean;
  readonly missingIcons: number;
}): void {
  const labels = {
    template_id: TEMPLATE_BY_PAGE_TYPE[input.pageType],
    page_type: input.pageType,
  };
  renderOverflowRounds.observe(labels, input.round);

  if (input.degraded) {
    renderDegradedTotal.inc({ reason_code: 'RENDER_OVERFLOW_UNRESOLVED' });
  }
  if (input.missingIcons > 0) {
    iconLoadFailureTotal.inc({}, input.missingIcons);
  }
}
