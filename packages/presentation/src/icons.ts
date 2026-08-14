import type { ModuleIconKey, ModuleIcons } from '@tps/schemas';

/**
 * 模块图标路径（设计稿 9.1、12.2）。
 *
 * ## 一处需要说明的设计张力
 *
 * 设计稿 12.2 把 `icons` 的值定为路径字符串（`/icons/travel/calendar.svg`），
 * 而 9.1 又要求图标**内联进构建产物**以达到 100% 加载成功率（验收标准 5）——
 * HTTP 请求做不到 100%。这两条放在一起看是矛盾的。
 *
 * 解决方式：保留路径形态的值（契约不变），但把它当作**稳定标识符**而不是
 * 抓取目标。模板通过编译期的穷尽映射把它换成内联的 React 组件
 * （见 packages/icon-library）。因此：
 *   - 契约与设计稿 12.2 完全一致，历史 ViewModel 仍可渲染
 *   - 运行期零网络请求，满足 9.1
 *   - 映射表用 `Record<ModuleIconKey, ...>`，新增图标键漏配是编译错误
 */
export const MODULE_ICON_PATHS: Record<ModuleIconKey, string> = {
  schedule: '/icons/travel/calendar.svg',
  food: '/icons/travel/food.svg',
  map: '/icons/travel/map.svg',
  route: '/icons/travel/route.svg',
  camera: '/icons/travel/camera.svg',
  ticket: '/icons/travel/ticket.svg',
  budget: '/icons/travel/budget.svg',
  tips: '/icons/travel/tips.svg',
};

/** ViewModel 的 `icons` 字段是常量，但仍走函数以便将来按模板变体切换图标集 */
export function moduleIcons(): ModuleIcons {
  return { ...MODULE_ICON_PATHS };
}
