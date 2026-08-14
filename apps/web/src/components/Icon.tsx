import { ICON_PATHS, resolveIconName, type IconName } from '@tps/icon-library';

/**
 * 图标组件（TP-1-03，设计稿 9.1）。
 *
 * 用 `dangerouslySetInnerHTML` 注入内联的 SVG 路径数据。
 *
 * 这里的 "dangerously" 名不副实：注入的内容来自 `@tps/icon-library` 的
 * **编译期常量**，由生成器校验过不含 `<script>`、外部引用与文字
 * （见 scripts/generate.mjs 的 FORBIDDEN_PATTERNS），不存在任何用户输入路径。
 * 替代方案是把每个 SVG 手写成 React 元素树，那样 19 个图标要维护
 * 几百行 JSX，且与源 SVG 之间没有任何一致性保证。
 */

export interface IconProps {
  /** 图标名或 ViewModel 中的路径（`/icons/travel/calendar.svg`），两种都接受 */
  readonly name: string;
  readonly size?: number;
  /** 无障碍标签。装饰性图标省略，会加 aria-hidden。 */
  readonly title?: string;
  readonly className?: string;
}

export function Icon({ name, size = 20, title, className }: IconProps) {
  const resolved = resolveIconName(name);

  if (resolved === null) {
    /*
     * 未知图标渲染为占位方框而不是静默返回 null。
     *
     * 缺图标是构建期就该发现的问题（生成器会校验清单完整性），
     * 能走到这里说明 ViewModel 里出现了清单外的引用。渲染可见的占位
     * 让视觉回归立刻抓到它；静默返回 null 只会让页面上少一个图标，
     * 而那恰好是验收标准 5 要防的情况。
     */
    return (
      <span
        data-icon-missing={name}
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          border: '1.6px dashed currentColor',
          borderRadius: 2,
          opacity: 0.5,
        }}
      />
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(title === undefined
        ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': title })}
      dangerouslySetInnerHTML={{ __html: iconInner(resolved, title) }}
    />
  );
}

function iconInner(name: IconName, title: string | undefined): string {
  const body = ICON_PATHS[name];
  return title === undefined ? body : `<title>${escapeXml(title)}</title>${body}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
