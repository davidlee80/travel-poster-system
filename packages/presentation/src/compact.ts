/**
 * 文案压缩规则（TP-1-09，设计稿 3.2.3）。
 *
 * 3.3 提到「哪些文字需要压缩」但没有算法；17.3 的溢出重渲染依赖压缩文案。
 *
 * 关键约束：压缩产物在 `BUILDING_PRESENTATION` 阶段**一次性预生成并随
 * ViewModel 落库**，渲染时溢出才启用。绝不在渲染循环里临时调用服务 ——
 * 17.3 最多重渲染 4 轮，每轮都调模型会让渲染预算（20 秒）直接爆掉。
 *
 * V1 只实现 L1 与 L2：
 *   L0  原文
 *   L1  去修饰、按标点截断到限长
 *   L2  规则化缩写（保留主谓宾骨架）
 *   L3  LLM 摘要 —— 接口预留，V1 默认关闭
 */

/** 中文标点，作为截断的优先边界 */
const CJK_BOUNDARY = /[。！？；，、：）】》」』]/;

/** 修饰性副词与程度词。删掉它们不改变信息，只减少字数。 */
const FILLER_WORDS = [
  '非常',
  '十分',
  '特别',
  '尤其',
  '相当',
  '格外',
  '比较',
  '稍微',
  '略微',
  '有些',
  '一些',
  '不妨',
  '可以说',
  '值得一提的是',
  '需要注意的是',
  '建议您',
  '您可以',
  '不失为',
  '堪称',
];

/** 常见冗余短语 → 简短等价表达 */
const PHRASE_SHORTHAND: readonly (readonly [RegExp, string])[] = [
  [/参观游览/g, '参观'],
  [/游览参观/g, '参观'],
  [/进行参观/g, '参观'],
  [/前往参观/g, '参观'],
  [/沿岸历史建筑/g, '沿岸建筑'],
  [/历史文化街区/g, '历史街区'],
  [/专题展览/g, '专题展'],
  [/深入了解/g, '了解'],
  [/充分感受/g, '感受'],
  [/细细品味/g, '品味'],
  [/漫步于/g, '漫步'],
  [/位于[^，。]{0,8}的/g, ''],
];

/** 去掉括号及其内容（含全角） */
function stripParentheses(text: string): string {
  return text
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '');
}

/** 折叠多余空白，并清理因删词产生的连续标点 */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([，。；、：])\1+/g, '$1')
    .replace(/^[，。；、：\s]+/, '')
    .trim();
}

/**
 * 在不超过 `maxChars` 的前提下，尽量在标点边界收尾。
 *
 * 找不到标点边界时硬截断并加省略号 —— 硬截断在中文里不像英文那样会切断
 * 单词，可读性损失有限，而超长导致的布局溢出是必然故障。
 */
function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // 从限长处向前找最近的标点
  for (let i = maxChars; i > Math.floor(maxChars * 0.5); i -= 1) {
    const ch = text[i - 1];
    if (ch !== undefined && CJK_BOUNDARY.test(ch)) {
      return text.slice(0, i).replace(/[，、：；]$/, '');
    }
  }

  // 省略号本身占 1 个字符，只有 maxChars >= 2 时才放得下。
  // maxChars === 1 时加省略号会让结果变成 2 个字符，反而破坏「不超限」这个
  // 唯一不变式 —— 而该不变式正是 17.3 第 2 轮重渲染有效的前提。
  return maxChars >= 2 ? `${text.slice(0, maxChars - 1)}…` : text.slice(0, maxChars);
}

/** L1：去修饰 + 去括号 + 按标点截断 */
export function compactL1(text: string, maxChars: number): string {
  if (text.length === 0) return text;

  let out = stripParentheses(text);
  for (const filler of FILLER_WORDS) {
    out = out.split(filler).join('');
  }
  out = normalize(out);

  return truncateAtBoundary(out, maxChars);
}

/** L2：在 L1 基础上做规则化缩写 */
export function compactL2(text: string, maxChars: number): string {
  if (text.length === 0) return text;

  let out = stripParentheses(text);
  for (const filler of FILLER_WORDS) {
    out = out.split(filler).join('');
  }
  for (const [pattern, replacement] of PHRASE_SHORTHAND) {
    out = out.replace(pattern, replacement);
  }
  out = normalize(out);

  // 仍超限时，只保留第一个完整分句
  if (out.length > maxChars) {
    const firstClause = out.split(/[。；！？]/).find((s) => s.trim().length > 0);
    if (firstClause !== undefined && firstClause.length <= maxChars) {
      out = firstClause.trim();
    }
  }

  return truncateAtBoundary(out, maxChars);
}

/**
 * 生成压缩文案：原文已达标时**直接返回原文**。
 *
 * 这一点很重要 —— 无条件压缩会让本来合规的文案也被削短，
 * 而 17.3 只在检测到溢出时才启用 `*_compact`，压缩一个不需要压缩的字段
 * 只会在触发降级时让页面变得比必要的更简陋。
 */
export function toCompact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const l1 = compactL1(text, maxChars);
  if (l1.length <= maxChars) return l1;

  return compactL2(text, maxChars);
}

/**
 * 各字段的限长（设计稿 3.3 的 content_limits 与业务规则 V-40）。
 *
 * 这些值决定了信息图的排版是否会溢出，与模板的 `data-overflow-guard`
 * 标注一一对应（17.3）。改这里必须同步跑视觉回归。
 */
export const COMPACT_LIMITS = {
  title: 18,
  subtitle: 32,
  scheduleDescription: 24,
  foodDescription: 20,
  dailySummary: 40,
} as const;

export type CompactLimitKey = keyof typeof COMPACT_LIMITS;
