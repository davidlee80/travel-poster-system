import type { Period, TransportMode, ModuleIconKey } from '@tps/schemas';
import { ICON_PATHS, type GeneratedIconName } from './generated/icons.js';

/**
 * 图标库（TP-1-03，设计稿 9.1）。
 *
 * 19 个图标：8 模块 + 5 时段 + 6 交通。全部内联，运行期零网络请求
 * （验收标准 5 要求 100% 加载成功率，HTTP 做不到）。
 *
 * ## 三张穷尽映射表是护栏的核心
 *
 * `Record<Period, GeneratedIconName>` 这类映射让「枚举新增了值但忘记加图标」
 * 变成**编译错误**。这比运行期兜底可靠得多 —— 兜底的表现是页面上出现一个
 * 莫名的默认图标，几乎不会有人注意到。
 */

export type IconName = GeneratedIconName;

export { ICON_PATHS };

/** 模块图标：ViewModel 的 `icons` 字段（12.2）对应的文件名 */
export const MODULE_ICON_BY_KEY: Record<ModuleIconKey, IconName> = {
  schedule: 'calendar',
  food: 'food',
  map: 'map',
  route: 'route',
  camera: 'camera',
  ticket: 'ticket',
  budget: 'budget',
  tips: 'tips',
};

/** 时段图标：`schedule[].period_icon` 对应（12.1） */
export const PERIOD_ICON_BY_ENUM: Record<Period, IconName> = {
  MORNING: 'period-morning',
  NOON: 'period-noon',
  AFTERNOON: 'period-afternoon',
  EVENING: 'period-evening',
  NIGHT: 'period-night',
};

/** 交通图标：`transport_tips[].icon` 对应（12.1） */
export const TRANSPORT_ICON_BY_ENUM: Record<TransportMode, IconName> = {
  WALK: 'transport-walk',
  TRANSIT: 'transport-transit',
  TAXI: 'transport-taxi',
  BOAT: 'transport-boat',
  BIKE: 'transport-bike',
  DRIVE: 'transport-drive',
};

/** 全部图标名 */
export const ALL_ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export function isIconName(value: string): value is IconName {
  return Object.hasOwn(ICON_PATHS, value);
}

/**
 * 把 ViewModel 里的图标引用（路径或名称）解析为图标名。
 *
 * ViewModel 的 `icons` 字段值是路径形态（`/icons/travel/calendar.svg`，
 * 见设计稿 12.2），而 `period_icon` / `transport_tips[].icon` 是名称形态。
 * 两种都要能解析 —— 这是 12.2 的契约与 9.1 的内联要求共存的必然结果。
 *
 * 解析失败返回 null 而不是兜底图标：缺图标是构建期就该发现的问题，
 * 运行期静默替换只会掩盖它。模板据此渲染占位方框，视觉回归会立刻抓到。
 */
export function resolveIconName(reference: string): IconName | null {
  if (isIconName(reference)) return reference;

  // `/icons/travel/calendar.svg` → `calendar`
  const fileName = reference.split('/').pop();
  if (fileName === undefined) return null;

  const base = fileName.replace(/\.svg$/, '');
  return isIconName(base) ? base : null;
}

export interface IconMarkupOptions {
  readonly size?: number;
  /** 无障碍标签。装饰性图标传 null，会加 aria-hidden。 */
  readonly title?: string | null;
  readonly className?: string;
}

/**
 * 生成完整的 `<svg>` 标记。
 *
 * 返回字符串而不是 React 元素：这样同一份实现可以同时服务
 * React 组件（`dangerouslySetInnerHTML` 的替代是直接构造元素，见 icon.tsx）
 * 与非 React 场景（SVG 路线图拼装、邮件模板）。
 */
export function iconMarkup(name: IconName, options: IconMarkupOptions = {}): string {
  const { size = 20, title = null, className } = options;
  const body = ICON_PATHS[name];

  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    'viewBox="0 0 24 24"',
    `width="${size}"`,
    `height="${size}"`,
    'fill="none"',
    'stroke="currentColor"',
    'stroke-width="1.6"',
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    className === undefined ? '' : `class="${className}"`,
    title === null ? 'aria-hidden="true" focusable="false"' : 'role="img"',
  ].filter((a) => a.length > 0);

  const titleTag = title === null ? '' : `<title>${escapeXml(title)}</title>`;

  return `<svg ${attrs.join(' ')}>${titleTag}${body}</svg>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
