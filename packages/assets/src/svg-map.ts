import type { MapStyle, RouteNode } from '@tps/schemas';
import { routeNodeHash, validRouteNodes } from './cache-keys.js';

/**
 * 路线示意图渲染（TP-3-10，设计稿 9.2、14.2）。
 *
 * 「示意图」是关键定语：它不是地图，没有底图、没有比例尺、没有道路。
 * 它回答的是「今天这几个点大致什么位置关系、按什么顺序走」——
 * 因此不需要地图数据源，节点坐标做等距投影就够。
 *
 * ## 三条硬约束
 *
 * 1. **坐标非法的节点剔除**（V-08 会把越界坐标修复为 null）。
 * 2. **有效节点少于 2 个不出图** —— 一个点的「路线」没有信息量，
 *    模板改用文字列表（8.2 的 `text_fallback`）。
 * 3. **不含外部引用**：没有 `<image>`、没有外部字体、没有 CSS 链接。
 *    这张 SVG 要在 PDF 导出里被 Chromium 渲染，任何外部引用都可能
 *    在导出时加载失败 —— 而那时页面已经截图完成，失败是静默的。
 *
 * 文字用 `font-family` 指定中文字体栈但不嵌入字体：渲染侧（17.5）
 * 已经装了 Noto Sans SC，而嵌入字体会让每张 SVG 膨胀几 MB。
 */

/** 8.2 的示例产物尺寸（1200×800，即 3:2） */
export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 800;
/** 节点标签需要的边距，避免文字被 viewBox 裁掉 */
const PADDING_X = 120;
const PADDING_Y = 90;

/** 少于 2 个有效节点不出图（9.2 的降级由调用方接管） */
export const MIN_ROUTE_NODES = 2;

interface Palette {
  readonly background: string;
  readonly line: string;
  readonly node: string;
  readonly nodeInner: string;
  readonly label: string;
  readonly index: string;
}

/**
 * 配色。V1 只有一种风格（14.2 的 `CANAL_GREEN`），
 * 但按 `map_style` 查表而不是写死 —— 它是缓存键的一段，
 * 写死会让「换了配色但键不变」变成可能，那意味着旧图继续被命中。
 */
const PALETTES: Record<MapStyle, Palette> = {
  CANAL_GREEN: {
    background: '#f2f7f4',
    line: '#4f8f74',
    node: '#2f6b52',
    nodeInner: '#ffffff',
    label: '#1f3d31',
    index: '#ffffff',
  },
};

export interface RenderMapInput {
  readonly nodes: readonly RouteNode[];
  readonly style: MapStyle;
}

export interface RenderedMap {
  readonly svg: string;
  /** 取 `viewBox` 尺寸（8.2） */
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly routeNodeHash: string;
  readonly style: MapStyle;
}

export type RenderMapResult =
  | { readonly kind: 'rendered'; readonly map: RenderedMap }
  /** 有效节点不足 2 个。调用方走 8.2 的 text_fallback */
  | { readonly kind: 'insufficient_nodes'; readonly validNodes: number };

/** SVG 文本转义。节点名来自 LLM 输出，必须当作不可信文本处理 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface Point {
  readonly x: number;
  readonly y: number;
  readonly name: string;
}

/**
 * 等距投影 + 等比缩放到画布。
 *
 * 经度按 `cos(平均纬度)` 压缩，否则在北纬 30 度附近东西向距离会被拉长
 * 约 15%，示意图上的方位关系明显失真。
 *
 * 纬度轴翻转：SVG 的 y 轴向下，而纬度向北增大。
 */
function project(nodes: readonly { name: string; latitude: number; longitude: number }[]): Point[] {
  const meanLat = nodes.reduce((acc, n) => acc + n.latitude, 0) / nodes.length;
  const lonScale = Math.cos((meanLat * Math.PI) / 180);

  const xs = nodes.map((n) => n.longitude * lonScale);
  const ys = nodes.map((n) => n.latitude);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX;
  const spanY = maxY - minY;

  const usableWidth = MAP_WIDTH - 2 * PADDING_X;
  const usableHeight = MAP_HEIGHT - 2 * PADDING_Y;

  /*
   * 全部节点在同一点（或同一条水平/垂直线）时跨度为 0。
   * 直接除会得到 Infinity/NaN，SVG 里表现为节点消失而不是报错。
   * 此时该轴不缩放，居中排布。
   */
  const scale =
    spanX === 0 && spanY === 0
      ? 0
      : Math.min(
          spanX === 0 ? Infinity : usableWidth / spanX,
          spanY === 0 ? Infinity : usableHeight / spanY,
        );

  const contentWidth = spanX * scale;
  const contentHeight = spanY * scale;
  const offsetX = (MAP_WIDTH - contentWidth) / 2;
  const offsetY = (MAP_HEIGHT - contentHeight) / 2;

  return nodes.map((node, index) => ({
    name: node.name,
    x: offsetX + (xs[index]! - minX) * (Number.isFinite(scale) ? scale : 0),
    y: MAP_HEIGHT - offsetY - (ys[index]! - minY) * (Number.isFinite(scale) ? scale : 0),
  }));
}

/** 标签放在节点上方还是下方：靠上边缘时放下面，避免出画布 */
function labelY(point: Point): number {
  return point.y < PADDING_Y ? point.y + 44 : point.y - 30;
}

export function renderSchematicMap(input: RenderMapInput): RenderMapResult {
  const nodes = validRouteNodes(input.nodes);
  if (nodes.length < MIN_ROUTE_NODES) {
    return { kind: 'insufficient_nodes', validNodes: nodes.length };
  }

  const palette = PALETTES[input.style];
  const points = project(nodes);
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const markers = points
    .map((point, index) => {
      const label = escapeXml(point.name);
      return [
        `<g>`,
        `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="18" fill="${palette.node}" />`,
        `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="7" fill="${palette.nodeInner}" />`,
        `<text x="${point.x.toFixed(1)}" y="${(point.y + 6).toFixed(1)}" text-anchor="middle" ` +
          `font-size="16" font-weight="700" fill="${palette.index}">${index + 1}</text>`,
        `<text x="${point.x.toFixed(1)}" y="${labelY(point).toFixed(1)}" text-anchor="middle" ` +
          `font-size="22" fill="${palette.label}">${label}</text>`,
        `</g>`,
      ].join('');
    })
    .join('');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" `,
    `width="${MAP_WIDTH}" height="${MAP_HEIGHT}" `,
    // 中文字体栈写在根节点，节点标签继承。渲染侧已装 Noto Sans SC（17.5）
    `font-family="Noto Sans SC, Noto Sans CJK SC, sans-serif" role="img" `,
    `aria-label="路线示意图，共 ${points.length} 个地点">`,
    `<rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="${palette.background}" />`,
    `<polyline points="${polyline}" fill="none" stroke="${palette.line}" stroke-width="6" `,
    `stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 10" />`,
    markers,
    `</svg>`,
  ].join('');

  return {
    kind: 'rendered',
    map: {
      svg,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      nodeCount: points.length,
      routeNodeHash: routeNodeHash(input.nodes),
      style: input.style,
    },
  };
}
