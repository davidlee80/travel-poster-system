import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { TEMPLATE_REGISTRY } from './registry';

/**
 * 样式套件必须满足的不变量（R-85 P2）。
 *
 * ## 这里守的不是「约束一致」
 *
 * 方案第 15 项原写的是「新模板的约束必须等于全局约束」，而核实后那条**无从违反**：
 * `HERO_CONSTRAINTS` 等四个常量是 `requirements.ts` 的模块级值，
 * 而 `requirementsForDay` 根本不收 `templateId` —— 没有任何代码路径能让某个
 * 套件改画幅。写一条测这个的用例只会给人「已经守住了」的错觉。
 *
 * 真正会被违反的是下面三条，它们的共同点是**违反了不报错**：
 * 页面照常渲出来，只是不对。
 */

const templatesRoot = path.dirname(fileURLToPath(import.meta.url));

/** 套件 ID（`ink_paper_v1`）与目录名（`ink-paper-v1`）的换算 */
function dirNameOf(templateId: string): string {
  return templateId.replaceAll('_', '-');
}

/** 每个套件都必须声明的配色 token。缺一个就会让某处取到浏览器默认值 */
const REQUIRED_PALETTE_TOKENS = [
  '--tps-ink',
  '--tps-ink-soft',
  '--tps-line',
  '--tps-paper',
  '--tps-accent',
  '--tps-accent-soft',
  '--tps-warm',
] as const;

/**
 * 字体角色 token。字体属于套件，因此每个套件必须把三个角色都指定。
 *
 * 缺了不会报错：`var()` 取不到值时退回浏览器默认字体，
 * 而那意味着 CJK 文本用系统字体渲 —— 导出的 PNG 在不同机器上不一样，
 * 而视觉基线又只在 Linux CI 上拍。
 */
const REQUIRED_FONT_TOKENS = [
  '--tps-title-font',
  '--tps-body-font',
  '--tps-numeric-font',
] as const;

describe('样式套件不变量', () => {
  it('每个已注册套件都有对应的目录（枚举与文件系统不能各说各话）', async () => {
    /*
     * 注册表是按路径 import 的，因此「枚举里有而目录没有」不会被 TypeScript
     * 抓到 —— 枚举值只是个字符串。不一致的后果是请求侧接受了一个套件 ID，
     * 而渲染时注册表查不到它 → 404，而 404 看不出是配置问题还是数据问题。
     */
    const dirs = (await readdir(templatesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const templateId of TEMPLATE_ID_VALUES) {
      expect(dirs, `套件 ${templateId} 缺目录`).toContain(dirNameOf(templateId));
    }
  });

  it('每个套件都同时提供两个页型（产品约束：任何模板都含全览页与每日页）', () => {
    /*
     * TypeScript 已经用 `Record<PageType, Component>` 强制了这一条，
     * 但那只管到**类型**。这条用例管到值：`undefined as any` 之类的写法能
     * 骗过类型而不会骗过这里。
     */
    for (const templateId of TEMPLATE_ID_VALUES) {
      const suite = TEMPLATE_REGISTRY[templateId];
      expect(suite, `套件 ${templateId} 未进注册表`).toBeDefined();
      expect(typeof suite?.DAILY_POSTER, `${templateId} 缺每日页`).toBe('function');
      expect(typeof suite?.FULL_PLAN, `${templateId} 缺全览页`).toBe('function');
    }
  });

  it('每个套件的 tokens.css 声明全部配色 token，且作用域是自己的 data-template', async () => {
    /*
     * **不满足会怎样**：漏声明的那个 token 在 `var()` 里取不到值，
     * 于是那一处退回浏览器默认（黑字、透明底）。页面照常渲出来 ——
     * 没有报错、没有降级计数，只是颜色不对。
     *
     * 作用域也要验：写成 `:root` 会让 token 泄漏到整个文档，
     * 而用户可见的计划页与规划器共用同一个文档。
     */
    for (const templateId of TEMPLATE_ID_VALUES) {
      const tokensPath = path.join(templatesRoot, dirNameOf(templateId), 'tokens.css');
      const css = await readFile(tokensPath, 'utf8');

      expect(css, `${templateId} 的 token 作用域不是自己的 data-template`).toContain(
        `[data-template='${templateId}']`,
      );
      expect(css, `${templateId} 不应把 token 写到 :root`).not.toMatch(/^\s*:root\s*\{/m);

      for (const token of [...REQUIRED_PALETTE_TOKENS, ...REQUIRED_FONT_TOKENS]) {
        expect(css, `${templateId} 缺 token ${token}`).toContain(`${token}:`);
      }
    }
  });

  it('模板 CSS 不直接引字体栈，只引角色 token（字体属于套件）', async () => {
    /*
     * `--tps-font-sans` / `-serif` / `-numeric` 是 `@tps/fonts` 注入到 `:root`
     * 的**全局**栈。模板直接引它们的后果是套件换不了字体 ——
     * 改那里会影响所有套件与规划器，不改则新套件只能沿用旧字体。
     *
     * 正确的形状是分两层：套件的 `tokens.css` 把角色指向某个全局栈（那一处
     * 引得着），而页型的 `styles.css` 只用角色 token。
     *
     * **先剔注释再判**：这条第一版直接扫全文，结果把解释「不该引全局栈」
     * 的注释当成了违例 —— 一条把自己的理由当成罪证的测试会逼着人删注释。
     */
    for (const templateId of TEMPLATE_ID_VALUES) {
      const suiteDir = path.join(templatesRoot, dirNameOf(templateId));
      for (const pageType of ['daily', 'full']) {
        const raw = await readFile(path.join(suiteDir, pageType, 'styles.css'), 'utf8');
        const css = raw.replaceAll(/\/\*[\s\S]*?\*\//g, '');
        expect(css, `${templateId}/${pageType} 直接引了全局字体栈`).not.toMatch(
          /var\(--tps-font-(sans|serif|numeric)\)/,
        );
      }
    }
  });

  it('每个套件的每日页实现了 relaxed 版式（17.3 第 4 轮靠它）', async () => {
    /*
     * **不满足会怎样**：17.3 的溢出修复有四轮，第 4 轮是「换宽松版式」——
     * 它靠 `[data-variant='relaxed']` 覆盖间距与字号来换取不溢出。
     * 套件不实现它的话那一轮**变成 no-op**：渲染器照样跑第 4 轮、照样测量、
     * 照样得到同一个溢出结果，然后判定「修复失败」并记降级。
     *
     * 也就是说缺了它不会崩，只会让降级产物占比无声上升，
     * 而排查时看到的是「第 4 轮也没救回来」而不是「第 4 轮什么都没做」。
     */
    for (const templateId of TEMPLATE_ID_VALUES) {
      const dailyCss = await readFile(
        path.join(templatesRoot, dirNameOf(templateId), 'daily', 'styles.css'),
        'utf8',
      );
      expect(dailyCss, `${templateId} 的每日页没有 relaxed 版式`).toContain(
        "[data-variant='relaxed']",
      );
    }
  });

  it('套件之间的类名不得相交（模板 CSS 是全局的）', async () => {
    /*
     * **这是本文件里唯一防「没有编译期保护」那类风险的守卫。**
     *
     * 模板的 `styles.css` 不是 CSS Module，是全局 CSS；而 `registry.ts`
     * 静态 import 全部套件的组件，每个组件又 import 自己的样式表 ——
     * 因此**所有套件的 CSS 都在同一个包里**。
     *
     * 两套套件用同一个类名的后果是后加载的那份胜出，于是一套的页面
     * 拿到另一套的样式。而那**既不会编译失败也不会运行时报错** ——
     * 只是渲出一张排版错乱的图，而任务仍然 COMPLETED。
     *
     * ink_paper 用的是 `.poster` / `.card` / `.list` 这类通用名（历史原因，
     * 当时只有一套），因此新套件必须用自己的前缀。这条不规定用什么前缀，
     * 只规定不能相交 —— 前缀只是满足它最简单的办法。
     */
    const classesBySuite = new Map<string, Set<string>>();

    for (const templateId of TEMPLATE_ID_VALUES) {
      const suiteDir = path.join(templatesRoot, dirNameOf(templateId));
      const classes = new Set<string>();

      for (const rel of ['tokens.css', 'daily/styles.css', 'full/styles.css']) {
        const file = path.join(suiteDir, ...rel.split('/'));
        const raw = await readFile(file, 'utf8').catch(() => '');
        // 先剔注释：注释里提到另一套的类名（比如解释为何要加前缀）不是违例
        const css = raw.replaceAll(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
          if (m[1] !== undefined) classes.add(m[1]);
        }
      }

      classesBySuite.set(templateId, classes);
    }

    const suites = [...classesBySuite.entries()];
    for (let i = 0; i < suites.length; i += 1) {
      for (let j = i + 1; j < suites.length; j += 1) {
        const [aId, aSet] = suites[i]!;
        const [bId, bSet] = suites[j]!;
        const shared = [...aSet].filter((name) => bSet.has(name));
        expect(shared, `${aId} 与 ${bId} 共用了类名：${shared.join(', ')}`).toEqual([]);
      }
    }
  });

  it('套件之间不共享配色字面量（换套件必须真的换色）', async () => {
    /*
     * 只有一套套件时这条恒真。它的价值在第二套出现时：如果新套件是从
     * ink_paper 复制过来改了几处，很容易留下大段相同的十六进制值 ——
     * 那意味着「换了样式」其实只换了一部分。
     *
     * 判据取「配色 token 的值集合不能完全相同」而不是「不能有任何重叠」：
     * 两套设计共用一个中性灰是正常的。
     */
    const palettes = new Map<string, string>();
    for (const templateId of TEMPLATE_ID_VALUES) {
      const css = await readFile(
        path.join(templatesRoot, dirNameOf(templateId), 'tokens.css'),
        'utf8',
      );
      const values = [...css.matchAll(/--tps-[a-z-]+:\s*([^;]+);/g)]
        .map((m) => m[1]?.trim() ?? '')
        .sort()
        .join('|');
      palettes.set(templateId, values);
    }

    const distinct = new Set(palettes.values());
    expect(distinct.size, `有套件的配色完全相同：${[...palettes.keys()].join(', ')}`).toBe(
      palettes.size,
    );
  });
});
