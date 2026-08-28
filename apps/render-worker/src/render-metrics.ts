import { createCounter, createHistogram } from '@tps/observability';
import { RENDER_ROUNDS } from '@tps/presentation';

import { RenderError } from './errors.js';

/**
 * 渲染质量指标（TP-5-01，设计稿 21.3）。
 *
 * 这三项在 P1～P4 一直缺失，而它们恰好是**验收标准 5 与 9 的唯一度量**：
 * 门禁 #9 要求 `travel_render_degraded_total = 0`、门禁 #5 要求
 * `travel_icon_load_failure_total` 恒为 0。没有它们时这两条只能靠人看截图。
 */

/** 页面类型。与 run-export 的日志字段取值一致，便于指标与日志对照 */
export type RenderPageType = 'day' | 'full';

/*
 * 原先这里有一张 `TEMPLATE_BY_PAGE_TYPE: Record<RenderPageType, TemplateId>`
 * （day → travel_infographic_v1、full → travel_full_plan_v1），已删（R-85）。
 *
 * 它的前提是「模板与页型一一对应」，而产品语义是一套样式套件同时提供
 * 两个页型。保留它的后果是 `template_id` 这个指标标签永远按页型反推，
 * 而不是报实际渲染的那一套 —— 也就是一个看起来正常却恒为错的维度。
 *
 * 现在 `recordRenderQuality` 收 `templateId`，由调用方从展示数据里拿。
 */

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

/**
 * 素材图片加载失败计数。
 *
 * ## 为什么 iconLoadFailureTotal 不够
 *
 * 上一项的注释写着「这个指标度量的不是网络失败，而是**契约漂移**」——
 * 这一项就是它明确排除掉的另一半：ViewModel 里的素材 URL 取不到。
 * 成因有三类，都是配置或运维问题而非代码缺陷：
 * `S3_PUBLIC_BASE_URL` 填了渲染容器解析不到的地址、素材桶不允许匿名读、
 * 对象已被清理而 ViewModel 永久保存（19.3）。
 *
 * ## 为什么必须有这一项
 *
 * `RenderReadyProbe` 刻意让坏图不阻塞就绪（十八章降级链），于是图片全部
 * 加载失败时：页面 ready、`degraded=false`、`missingIcons=0`、导出 COMPLETED。
 * 用户拿到一张图片位置全空白的长图，而**所有健康信号都是绿的**。
 *
 * 分子分母都记（`total` 走下面那个 gauge 式的 `_seen_total`）是因为
 * 「21 张里坏 1 张」与「21 张全坏」在处置上完全不同：前者是降级链正常工作，
 * 后者是配置错误。只记失败数无法区分，而告警需要的是比例。
 *
 * 不进 `travel_render_degraded_total`：那一项是 21.3 算「降级产物占比」的
 * 分子，专指 17.3 的溢出未解决。混进图片失败会让那个比率失去原本含义。
 */
export const assetImageFailureTotal = createCounter({
  name: 'travel_render_asset_image_failure_total',
  help: '渲染页面中加载失败的素材图片数（S3_PUBLIC_BASE_URL 不可达 / 桶权限 / 对象缺失）',
  labelNames: ['page_type'],
});

/** 分母：见过的 `<img>` 总数。告警要的是失败**比例**，只有分子判不出严重性 */
export const assetImageSeenTotal = createCounter({
  name: 'travel_render_asset_image_seen_total',
  help: '渲染页面中的素材图片总数（travel_render_asset_image_failure_total 的分母）',
  labelNames: ['page_type'],
});

/**
 * 渲染失败计数（TP-5-04，R-42）。
 *
 * ## 为什么要这一项
 *
 * 21.3 的六条告警里有一条是「字体故障：**日志出现** `CJK_FONT_UNAVAILABLE`」。
 * 但告警规则文件是 Prometheus 的，而 Prometheus 不看日志 —— 对日志告警需要
 * Loki ruler 或 ELK watcher，V1 没有部署那一套。照原文写就是一条**永远不会
 * 触发**的告警：规则文件里放一个 Prometheus 读不懂的条件，看起来告警配好了。
 *
 * 而字体故障本来就有一个明确的标识（`RenderError.detail`，其注释从 P1 起就
 * 写着「用于日志与指标细分」，只是从未有指标用它）。把它计成指标，
 * 那条告警就落在 Prometheus 能判定的东西上。
 *
 * 不复用 `travel_render_degraded_total`：那一项是 21.3 用来算「降级产物占比」
 * 的分子，混进失败会让那个比率失真 —— 降级产物是**交付了的**，失败没有。
 *
 * `reason_code` 取 `detail ?? code`：前者更具体
 * （`CJK_FONT_UNAVAILABLE` / `CANVAS_OVERFLOW_X` / `READY_NOT_REACHED` /
 * `BODY_FONT_NOT_SUBSET` / `BUDGET_EXHAUSTED_BEFORE_START`），
 * 全部是编译期已知的常量，取值有界。
 */
export const renderFailureTotal = createCounter({
  name: 'travel_render_failure_total',
  help: '渲染失败计数（按 13.7 错误码或更具体的原因标识）',
  labelNames: ['reason_code'],
});

/** 非 RenderError 的失败归到这一个值，避免把异常消息当标签（基数不可控） */
export const UNKNOWN_RENDER_REASON = 'UNKNOWN';

/**
 * Chromium 重启计数（R-84）。
 *
 * ## 为什么它不能并入 `travel_render_failure_total`
 *
 * 重启本身不是一次渲染失败 —— 崩溃那一刻失败的导出已经各自计入
 * `travel_render_failure_total` 了。这一项回答的是一个不同的问题：
 * **浏览器到底崩过几次**。合在一起会让「一次崩溃带倒三个导出」与
 * 「三次无关的渲染失败」在图上一模一样，而两者的处置完全不同：
 * 前者要看内存与 /dev/shm，后者要看模板与素材。
 *
 * 取值有界：当前只有 `BROWSER_DISCONNECTED` 一个（唯一会触发重启的原因）。
 * 保留 `reason_code` 标签而不是无标签，是为了将来多一种触发因（比如主动
 * 回收）时不用改指标名 —— 改名会断掉历史曲线。
 */
export const browserRestartTotal = createCounter({
  name: 'travel_render_browser_restart_total',
  help: 'Chromium 断开后重启的次数（不含首次启动）',
  labelNames: ['reason_code'],
});

export function recordRenderFailure(error: unknown): void {
  const reason =
    error instanceof RenderError
      ? (error.detail ?? error.code)
      : /* c8 ignore next */ UNKNOWN_RENDER_REASON;
  renderFailureTotal.inc({ reason_code: reason });
}

/** 一次页面渲染的质量观测 */
export function recordRenderQuality(input: {
  readonly pageType: RenderPageType;
  /**
   * 实际渲染的样式套件（R-85）。
   *
   * 原先这个标签取自 `TEMPLATE_BY_PAGE_TYPE[pageType]` —— 一张硬编码映射表，
   * 它把页型当成模板。多套样式并存后那个标签会**说谎**：用户选了 kraft，
   * 指标仍报 ink_paper，于是「哪套模板溢出多」这类问题无法回答。
   *
   * 类型是 `string` 而不是 `TemplateId`：值来自 `exports.template_id`，
   * 那一列是 `VARCHAR(100)` 无 CHECK。基数的实际边界来自导出接口的
   * `TemplateIdSchema` 校验 —— 而不是这里的类型声明。
   */
  readonly templateId: string;
  readonly round: number;
  readonly degraded: boolean;
  readonly missingIcons: number;
  readonly images: { readonly total: number; readonly broken: number };
}): void {
  const labels = {
    template_id: input.templateId,
    page_type: input.pageType,
  };
  renderOverflowRounds.observe(labels, input.round);

  if (input.degraded) {
    renderDegradedTotal.inc({ reason_code: 'RENDER_OVERFLOW_UNRESOLVED' });
  }
  if (input.missingIcons > 0) {
    iconLoadFailureTotal.inc({}, input.missingIcons);
  }

  /*
   * 分母无条件记，包括 total 为 0 的页面 —— 否则「这一页本来就没有图」与
   * 「这一页的图全没加载」在指标上无法区分，而两者一个正常一个是故障。
   */
  assetImageSeenTotal.inc({ page_type: input.pageType }, input.images.total);
  if (input.images.broken > 0) {
    assetImageFailureTotal.inc({ page_type: input.pageType }, input.images.broken);
  }
}
