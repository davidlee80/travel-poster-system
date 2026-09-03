#!/usr/bin/env node
/**
 * 扫描 planner.css 的选择器作用域（门禁 #53，设计稿 5.2、P9 Global Constraints）。
 *
 * ## 这条纪律防的是什么
 *
 * `globals.css` 由根 layout 引入，而 `/render/**` 的信息图页面是它的后代。
 * 因此写到 `body` / `:root` 的规则会漏进导出链路：
 *
 * ```css
 * body { background: #f5f7fb }              → 导出 PNG 的底色从白变灰
 * body { font-family: Inter, "PingFang SC" } → 绕过 @tps/fonts 的自托管子集
 * ```
 *
 * 两者的共同点是**页面看起来完全正常** —— 采集界面确实好看了，而坏掉的是
 * 另一条链路上的产物。第二条尤其隐蔽：字体仍然能渲染出中文（系统回退），
 * 只是不再是视觉基线拍的那一份，于是 `pnpm test:visual` 变红而原因在另一个文件里。
 *
 * ## 为什么必须是工具而不是 code review
 *
 * P9-8 手工核对过一次（当时 319 个选择器全部以 `.planner` 开头）。但那是一次性的：
 * 下一个改样式的人不会知道有这条纪律，而**违反它不会让任何测试变红**（除了
 * 视觉基线，而那条的报错信息指向截图差异，不指向这里）。
 *
 * ## 判据
 *
 * 每一条选择器都必须以 `.planner` 开头。这不要求它是 `.planner` 的后代 ——
 * `.planner-shell` 这样的独立类名同样合格，因为它一样进不了 `body` / `:root`。
 * 判据取「前缀」而不是「后代」是刻意的：后者会拦掉一批正当写法，
 * 而一个总在报假警的门禁会被关掉。
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

/** 受这条纪律约束的文件。globals.css **不在**列内 —— 字体令牌刻意挂在 :root */
const TARGETS = ['apps/web/src/app/planner.css'];

/** 要求的选择器前缀 */
const SCOPE = '.planner';

/**
 * 解析失效的下限。
 *
 * 本工具最可能的失效方式是**静默通过一切**：正则或括号配对一变，
 * `extractSelectors` 返回空数组，于是「0 处违规」—— 而那与「代码干净」
 * 在输出上完全一样。因此低于这个数直接报错。
 * P9-8 实测 319 条，取 200 作下限留出删改余量。
 */
const MIN_EXPECTED_SELECTORS = 200;

/** 这些 at-rule 的子块里装的是普通选择器，要继续检查 */
const NESTS_SELECTORS = new Set(['media', 'supports', 'layer', 'container']);

/**
 * 这些 at-rule 的子块里装的**不是**选择器，跳过。
 *
 * `@keyframes` 里是 `from` / `to` / `50%` —— 它们长得像裸元素选择器，
 * 但作用域由 `animation-name` 决定，与 CSS 级联无关。
 * 不区分的话每个动画都会报三四条假警。
 */
const OPAQUE_AT_RULES = new Set(['keyframes', 'font-face', 'property', 'counter-style', 'page']);

/** 去掉注释。必须先做 —— planner.css 的文件头注释里就有 `body { ... }` 的反例 */
function stripComments(css) {
  // 用等长空白替换，保住行号
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 提取全部选择器。
 *
 * 走一遍字符，按大括号深度维护 at-rule 栈：遇到 `{` 时，它前面那段
 * （上一个 `{` 或 `}` 之后的文本）就是选择器列表或 at-rule 前导。
 */
export function extractSelectors(rawCss) {
  const css = stripComments(rawCss);
  const selectors = [];
  /** 每层是 'selectors' | 'opaque' | 'declarations' */
  const stack = [];
  let chunkStart = 0;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char !== '{' && char !== '}') continue;

    if (char === '}') {
      stack.pop();
      chunkStart = i + 1;
      continue;
    }

    const prelude = css.slice(chunkStart, i).trim();
    chunkStart = i + 1;

    // 已经在「不是选择器」的块里（@keyframes 内部、或声明块内部）
    if (stack.length > 0 && stack[stack.length - 1] !== 'selectors') {
      stack.push('declarations');
      continue;
    }

    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (OPAQUE_AT_RULES.has(name)) {
        stack.push('opaque');
      } else if (NESTS_SELECTORS.has(name)) {
        stack.push('selectors');
      } else {
        // 未知 at-rule：按「里面是选择器」处理，宁可多查不可漏查
        stack.push('selectors');
      }
      continue;
    }

    if (prelude.length > 0) {
      for (const part of prelude.split(',')) {
        const selector = part.trim();
        if (selector.length === 0) continue;
        selectors.push({ selector, line: lineOf(css, i) });
      }
    }
    stack.push('declarations');
  }

  return selectors;
}

export function offendingSelectors(selectors) {
  return selectors.filter(({ selector }) => !selector.startsWith(SCOPE));
}

// ── 自检 ────────────────────────────────────────────────

function selfTest() {
  const mustCatch = [
    ['裸 body', 'body { background: #f5f7fb }'],
    [':root 令牌', ':root { --bg: #fff }'],
    ['裸元素', 'a { color: red }'],
    ['多选择器里夹一个未作用域的', '.planner .x, h1 { margin: 0 }'],
    ['media 内的 body', '@media (width <= 767px) { body { padding: 0 } }'],
    ['前缀不在开头', '.wrap .planner { gap: 8px }'],
  ];
  const mustPass = [
    ['作用域根', '.planner { color: #111 }'],
    ['后代通配', '.planner *, .planner *::before { box-sizing: border-box }'],
    ['独立命名空间类', '.planner-shell { display: grid }'],
    ['media 内的作用域选择器', '@media (width <= 767px) { .planner .rail { display: none } }'],
    [
      'keyframes 的 from/to 不是选择器',
      '@keyframes planner-fade { from { opacity: 0 } to { opacity: 1 } }',
    ],
    ['keyframes 的百分比同理', '@keyframes planner-rise { 0% { top: 0 } 100% { top: 8px } }'],
    ['注释里的反例不算', '/* 反例：body { background: #f5f7fb } */ .planner { color: #111 }'],
  ];

  const failures = [];

  for (const [name, sample] of mustCatch) {
    if (offendingSelectors(extractSelectors(sample)).length === 0) {
      failures.push(`应当被检出但放过了（${name}）：${sample}`);
    }
  }
  for (const [name, sample] of mustPass) {
    const found = offendingSelectors(extractSelectors(sample));
    if (found.length > 0) {
      failures.push(`误报（${name}）：${found.map((f) => f.selector).join(', ')}  ← ${sample}`);
    }
  }

  if (failures.length > 0) {
    console.error('CSS 作用域扫描器自检失败：\n');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    `自检通过：${mustCatch.length} 个违规样本全部检出，${mustPass.length} 个合规样本无误报。`,
  );
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

// ── 扫描 ────────────────────────────────────────────────

let total = 0;
const offenses = [];

for (const target of TARGETS) {
  const file = join(ROOT, target);
  const selectors = extractSelectors(readFileSync(file, 'utf8'));
  total += selectors.length;
  for (const entry of offendingSelectors(selectors)) {
    offenses.push({ file: relative(ROOT, file).split(sep).join('/'), ...entry });
  }
}

if (total < MIN_EXPECTED_SELECTORS) {
  console.error(
    `只解析到 ${total} 个选择器（预期至少 ${MIN_EXPECTED_SELECTORS} 个）。\n` +
      'CSS 的写法可能变了（例如引入了嵌套语法）—— 请修正本工具的解析，' +
      '而不是降低下限：一个解析不到东西的扫描器会把「0 处违规」当成通过。',
  );
  process.exit(1);
}

if (offenses.length > 0) {
  console.error('planner.css 出现了未作用域的选择器（设计稿 5.2、P9 Global Constraints）：\n');
  for (const offense of offenses) {
    console.error(`  ${offense.file}:${offense.line}`);
    console.error(`    选择器 ${offense.selector}  ← 未以 ${SCOPE} 开头`);
  }
  console.error(
    `\n共 ${offenses.length} 处。globals.css 由根 layout 引入，而 /render/** 的信息图页面\n` +
      '是它的后代 —— 写到 body / :root 会让导出 PNG 的底色变灰、字体绕过 @tps/fonts\n' +
      '的自托管子集，而采集页面本身看起来完全正常。请把规则挂到 .planner 之下。',
  );
  process.exit(1);
}

console.log(`CSS 作用域扫描通过：${total} 个选择器全部以 ${SCOPE} 开头。`);
