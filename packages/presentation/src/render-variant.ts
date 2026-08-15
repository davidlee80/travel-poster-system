/**
 * 渲染变体解析（设计稿 17.3 的四轮重渲染）。
 *
 * 渲染 Worker 通过查询参数驱动降级，而不是通过多个路由：
 *   第 1 轮  （无参数）                     原始 ViewModel
 *   第 2 轮  ?compact=1                     切换 *_compact 文案
 *   第 3 轮  ?compact=1&hide=30             隐藏低于该优先级的条目
 *   第 4 轮  ?compact=1&hide=60&layout=relaxed  宽松版式
 *
 * 用查询参数的好处是同一份 ViewModel 只取一次，四轮之间无需重新构造数据 ——
 * 渲染总预算只有 20 秒（17.3），省下的每一次数据构造都有意义。
 *
 * ## 为什么放在 @tps/presentation 而不是 @tps/shared
 *
 * 它同时被 Next 的渲染页面（会被 webpack 打包）与渲染 Worker 引用。
 * `@tps/shared` 的 barrel 会连带引入 `@node-rs/argon2` 的原生 `.node` 二进制，
 * webpack 无法打包它 —— 从渲染页面引用 shared 会直接让 `next build` 失败。
 * presentation 是纯 TS（只依赖 zod），两侧都能安全引用。
 */

export type RenderLayout = 'default' | 'relaxed';

export interface RenderVariant {
  readonly compact: boolean;
  readonly hideBelowPriority: number | null;
  readonly layout: RenderLayout;
}

type Query = Record<string, string | string[] | undefined>;

function first(query: Query, key: string): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseRenderVariant(query: Query): RenderVariant {
  const compact = first(query, 'compact') === '1';

  const hideRaw = first(query, 'hide');
  const hide = hideRaw === undefined ? Number.NaN : Number(hideRaw);
  /*
   * 上限 80：17.3 规定隐藏到 priority >= 80 时停止并转为宽松版式。
   * 允许更高的值等于允许隐藏标题与金额，那不是降级而是产出错误页面。
   */
  const hideBelowPriority = Number.isInteger(hide) && hide > 0 && hide <= 80 ? hide : null;

  const layout: RenderLayout = first(query, 'layout') === 'relaxed' ? 'relaxed' : 'default';

  return { compact, hideBelowPriority, layout };
}

/** 四轮重渲染对应的参数（渲染 Worker 按序尝试） */
export const RENDER_ROUNDS: readonly RenderVariant[] = [
  { compact: false, hideBelowPriority: null, layout: 'default' },
  { compact: true, hideBelowPriority: null, layout: 'default' },
  { compact: true, hideBelowPriority: 60, layout: 'default' },
  { compact: true, hideBelowPriority: 80, layout: 'relaxed' },
];

export function variantToQuery(variant: RenderVariant): string {
  const params = new URLSearchParams();
  if (variant.compact) params.set('compact', '1');
  if (variant.hideBelowPriority !== null) params.set('hide', String(variant.hideBelowPriority));
  if (variant.layout === 'relaxed') params.set('layout', 'relaxed');

  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
}
