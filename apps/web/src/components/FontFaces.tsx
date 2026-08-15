import {
  FONT_STACK_NUMERIC,
  FONT_STACK_SANS,
  FONT_STACK_SERIF,
  fontAssets,
  fontFaceCss,
} from '@tps/fonts';

/**
 * 字体声明与预加载（TP-1-04，设计稿 17.5）。
 *
 * ## 为什么在 layout 里注入 `<style>` 而不写进 globals.css
 *
 * `@font-face` 规则与 CSS 变量都由 `@tps/fonts` 的清单派生。写进 globals.css
 * 就成了手抄副本：加一档字重要改两处，而漏改的表现是「加粗标题静默变回退字体」，
 * 没有任何报错。这里注入等于让清单直接生效，副本不存在。
 *
 * CSS 变量也只在这里定义 —— 若 globals.css 里也有一份，两份的生效顺序
 * 取决于 Next 把样式表和这个 `<style>` 放在 `<head>` 的哪个位置，
 * 那是不该依赖的实现细节。
 *
 * ## 为什么要显式 preload
 *
 * `font-display: block` 下浏览器在字体到位前不绘制任何文字。若不预加载，
 * 字体请求要等 CSS 解析完才发出，渲染 Worker 的等待时间白白多一个往返 ——
 * 而单次渲染预算只有 5 秒（17.3）。
 *
 * 只预载 400 与 700：500 用于小标题，出现晚且量少，预载它反而挤占
 * 正文字体的带宽。
 */

const PRELOADED_WEIGHTS = new Set([400, 700]);

export function FontFaces() {
  const css = [
    fontFaceCss('/fonts/'),
    '',
    ':root {',
    `  --tps-font-sans: ${FONT_STACK_SANS};`,
    `  --tps-font-serif: ${FONT_STACK_SERIF};`,
    `  --tps-font-numeric: ${FONT_STACK_NUMERIC};`,
    '}',
  ].join('\n');

  return (
    <>
      {fontAssets()
        .filter(({ weight }) => PRELOADED_WEIGHTS.has(weight))
        .map(({ file }) => (
          <link
            key={file}
            rel="preload"
            href={`/fonts/${file}`}
            as="font"
            type="font/woff2"
            // 自托管同源字体也必须声明 crossOrigin，否则浏览器会发两次请求：
            // 预载用的匿名请求与实际用的凭据请求不共享缓存
            crossOrigin="anonymous"
          />
        ))}
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </>
  );
}
