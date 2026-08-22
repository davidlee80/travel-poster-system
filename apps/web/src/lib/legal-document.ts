import { readFileSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

/**
 * 用户协议与隐私政策的页面数据源（`/legal`）。
 *
 * ## 为什么在构建期读 `docs/` 而不是把政策抄进组件里
 *
 * 那份 markdown 是政策的**唯一真相源** —— `pnpm test:docs` 拿它与界面提示条
 * 比对保留期数字，法务定稿也会改那一份。再抄一份进 React 组件就有了两个版本，
 * 而分叉之后用户看到的是组件那份、测试校验的是 docs 那份：
 * 一致性检查全绿，页面上写的却是旧承诺。
 *
 * 读取发生在 `next build`（页面是静态预渲染的，见 `app/legal/page.tsx` 的
 * `force-static`），因此运行期镜像里不需要 `docs/` —— 但**构建阶段需要**，
 * 所以 `deploy/images/web.Dockerfile` 显式拷了这个文件。文件不在时构建
 * 直接失败，这是想要的：静默产出一个空白政策页远比构建失败糟。
 *
 * ## 为什么要切掉开头那一段
 *
 * 文件开头是给维护者看的引用块（「本文件是草案」「由某个测试校验」）。
 * 原样渲染给用户是荒谬的 —— 一份自称草案、还提到测试文件路径的隐私政策。
 * 边界是**第一条 `---`**，这个约定写在那份文档自己的引用块里。
 */

/** 政策文档相对仓库根的位置 */
const POLICY_RELATIVE_PATH = path.join('docs', '用户协议与隐私政策.md');

export interface LegalDocument {
  /** 一级标题的文字，用作页面标题 */
  readonly title: string;
  /** 正文渲染出的 HTML（不含标题） */
  readonly html: string;
}

/**
 * 定位仓库根。
 *
 * `next build` 与 `next dev` 的 cwd 都是 `apps/web`，因此往上两级。
 * 猜错时 `readFileSync` 抛错、构建失败 —— 不做兜底是有意的，
 * 「找不到就渲染一个空页面」会让缺失的政策页悄悄上线。
 */
function repositoryRoot(): string {
  return path.resolve(process.cwd(), '..', '..');
}

/** 切掉第一条 `---` 之前的内部说明；没有 `---` 时原样返回 */
export function stripInternalPreamble(markdown: string): string {
  const lines = markdown.split('\n');
  const separator = lines.findIndex((line) => line.trim() === '---');
  if (separator === -1) return markdown;
  return lines.slice(separator + 1).join('\n');
}

/** 取出一级标题的文字，并把它从正文里去掉（页面自己渲染标题） */
export function extractTitle(markdown: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.startsWith('# '));
  if (index === -1) return { title: '用户协议与隐私政策', body: markdown };

  const title = lines[index]!.slice(2).trim();
  return { title, body: [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n') };
}

/**
 * 读并渲染政策文档。
 *
 * 在服务端调用（构建期）。`marked` 的输出直接进 `dangerouslySetInnerHTML` ——
 * 输入是仓库里的一个文件，不含任何用户输入，因此这里没有注入面。
 */
export function loadLegalDocument(): LegalDocument {
  const raw = readFileSync(path.join(repositoryRoot(), POLICY_RELATIVE_PATH), 'utf8');
  const { title, body } = extractTitle(raw);
  const html = marked.parse(stripInternalPreamble(body), { async: false, gfm: true });

  return { title, html };
}
