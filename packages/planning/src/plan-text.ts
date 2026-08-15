/**
 * V-44 / V-45 的文本判定与清洗（TP-2-12、TP-2-13）。
 *
 * 判定（规则）与清洗（修复）必须共用同一套模式，否则会出现规则报「含
 * Markdown 标记」而清洗函数认不出那个标记的情况 —— 表现是**修不掉的
 * REPAIRABLE**：每轮都报同一条，3 轮耗尽后降级成一条用户看不懂的假设。
 *
 * 独立成模块而不是放在其中一侧，是为了避免 plan-rules 与 repair-plan
 * 互相 import 形成循环。
 */

/**
 * URL：只认 `://`。
 *
 * 按协议名逐个列举（http、https、ftp……）必然漏掉某一个，而漏掉的那个
 * 正好是别人会用的。`://` 一条覆盖全部带层级的协议。
 */
export const URL_PATTERN = /:\/\//;

/** HTML：单字符检查同时覆盖完整标签与残缺的半个标签 */
export const ANGLE_BRACKET_PATTERN = /[<>]/;

export const MARKDOWN_PATTERNS: readonly RegExp[] = [
  /\*\*/,
  /^\s*#{1,6}\s/,
  /^\s*[-*+]\s/,
  /^\s*>\s/,
  /~~/,
  /`/,
  /\[[^\]]*\]\([^)]*\)/,
];

/**
 * 占位词。
 *
 * `undefined` / `null` / `NaN` 作为**文本**出现，是模型把 JS 值直接拼进
 * 字符串的典型痕迹（`` `${city}的${undefined}` ``）。它们不是合法中文内容。
 */
export const PLACEHOLDER_PATTERN = /\b(?:undefined|null|NaN)\b/;

const HTML_TAG_PATTERN = /<[^>]*>/g;

/**
 * URL 的字符集按 RFC 3986 限定，**不能用 `\S*`** ——
 * 中文不是空白字符，`\S*` 会把 `详见http://x.com的开放时间`
 * 从「详见」之后整句吃掉。
 */
const URL_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%[\]]*/g;

const STRAY_ANGLE_PATTERN = /[<>]/g;

/** 剥离 URL 与 HTML（V-45，1.2「模型不生成 HTML」的执行点） */
export function stripUrlAndHtml(text: string): string {
  return text
    .replace(HTML_TAG_PATTERN, '')
    .replace(URL_TOKEN_PATTERN, '')
    .replace(STRAY_ANGLE_PATTERN, '');
}

/**
 * 清洗 Markdown 残留与占位词（V-44）。
 *
 * `[文字](链接)` 保留方括号里的文字：那是模型想表达的内容，
 * 整条删掉会让句子缺一个成分。
 */
export function cleanText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/~~/g, '')
    .replace(/`/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s+/, '')
    .replace(/\b(?:undefined|null|NaN)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 规则与修复共用的「归一化后的文本」 */
export function normalizeText(text: string): string {
  return cleanText(stripUrlAndHtml(text));
}
