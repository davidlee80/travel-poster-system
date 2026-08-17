/**
 * 键与名称归一化（设计稿 19.1）。
 *
 * 19.1 的六步：去首尾空白 → 全角转半角 → 繁体转简体 → 去括号及内容 →
 * 小写化拉丁字符 → 非字母数字替换为 `_` 并合并。
 *
 * ## R-26：两处偏离，都是有意的
 *
 * **1. 不做繁体转简体。** 需要一张完整的繁简对照表（opencc 级别的数据）。
 * V1 的 locale 只有 `zh-CN`，模型输出是简体，而目的地维度**优先用
 * `place_id`**（19.1 明确要求），因此繁体只可能出现在用户自由文本派生的
 * 名称里。代价是有界的：`靈隱寺` 与 `灵隐寺` 会得到两个键，即多生成一次。
 * 引入对照表以后，键会全部变化 —— 而 19.2 的键版本号（`v1`）正是为这类
 * 变更准备的，届时递增即可，旧产物保留用于回滚。
 *
 * **2. 不做拼音转写。** 19.1 的 `dish_name` 示例
 * （「葱包桧与小馄饨」→ `cong_bao_gui_yu_xiao_hun_tun`）暗示要转拼音，
 * 但那对缓存键**有害**：
 *   - 需要一个带字典的依赖，字典更新会让存量键静默变化；
 *   - 同音字合并会**增加碰撞**（`拱宸桥` 与 `拱辰桥` 转出同一串拼音），
 *     而缓存键碰撞的表现是「A 菜的图出现在 B 菜的位置」。
 * 缓存键的功能要求是「同输入同键、异输入异键」，可读性是次要的。
 * 因此 CJK 字符原样保留：`food:v1:葱包桧与小馄饨:杭州:realistic_food_photography`。
 * 它存在 `assets.cache_key`（TEXT 列）与 Redis 键里，两者都是 UTF-8 安全的。
 */

/**
 * 全角空格（U+3000）。
 *
 * 用 `String.fromCharCode` 而不是字面量：字面量在编辑器里与半角空格
 * 完全无法分辨，而这一行的作用恰恰是把两者区分开。
 * ESLint 的 `no-irregular-whitespace` 也会拦下字面量写法。
 */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** 全角 ASCII（FF01–FF5E）与全角空格（3000）转半角 */
export function fullWidthToHalf(text: string): string {
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .split(IDEOGRAPHIC_SPACE)
    .join(' ');
}

/** 去掉括号及其内容：「拱宸桥（运河段）」→「拱宸桥」 */
export function stripBrackets(text: string): string {
  return text
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '');
}

/** CJK 统一表意文字（含扩展 A）与假名之外的字符视为分隔符 */
const KEEP_PATTERN = /[a-z0-9㐀-䶿一-鿿]+/g;

/**
 * 归一化为缓存键的一个段。
 *
 * 产物只含小写拉丁字母、数字、CJK 与作为分隔符的下划线，
 * 因此不会与 19.2 键格式里的 `:` 冲突 —— 名称里出现冒号会把一个段
 * 拆成两个，让键的段数不定，解析与统计全部失效。
 */
export function normalizeKeySegment(text: string): string {
  const cleaned = fullWidthToHalf(text).trim();
  const withoutBrackets = stripBrackets(cleaned).toLowerCase();

  const parts = withoutBrackets.match(KEEP_PATTERN);
  return parts === null ? '' : parts.join('_');
}

/**
 * 归一化为**比较用**的名称（10.1 的 `entity_match` / `destination_match`）。
 *
 * 与键段归一化的区别只有一处：这里不插入下划线。
 * 「拱宸桥 历史街区」与「拱宸桥历史街区」应当判为子串关系，
 * 而带下划线的形式（`拱宸桥_历史街区`）会让子串判断失效。
 */
export function normalizeName(text: string): string {
  const cleaned = fullWidthToHalf(text).trim();
  const withoutBrackets = stripBrackets(cleaned).toLowerCase();

  const parts = withoutBrackets.match(KEEP_PATTERN);
  return parts === null ? '' : parts.join('');
}

/**
 * 分词（用于 Jaccard 相似度）。
 *
 * 拉丁词按空白与标点切分；CJK 按**二元组**（bigram）切分 ——
 * 单字切分会让「博物馆」与「馆」高度相似，而 bigram 保留了局部词序，
 * 是无词典条件下最稳的中文切分方式。同一套策略也用于 `search_text`
 * 的构造（GIN 索引侧），两处必须一致，否则倒排召回与打分口径不同。
 */
export function tokenize(text: string): string[] {
  /*
   * 这里**不能**用 `normalizeName`：它把各段拼在一起，
   * `west lake` 会变成一个 `westlake` 词，与 `lake west` 的 Jaccard 变成 0。
   * 分词需要保留分隔信息，因此直接取匹配段。
   */
  const cleaned = stripBrackets(fullWidthToHalf(text).trim()).toLowerCase();
  const segments = cleaned.match(KEEP_PATTERN) ?? [];

  const tokens: string[] = [];
  for (const segment of segments) {
    for (const latin of segment.match(/[a-z0-9]+/g) ?? []) {
      tokens.push(latin);
    }

    for (const cjk of segment.split(/[a-z0-9]+/).filter((part) => part.length > 0)) {
      if (cjk.length === 1) {
        tokens.push(cjk);
        continue;
      }
      for (let i = 0; i + 1 < cjk.length; i += 1) {
        tokens.push(cjk.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/** Jaccard 相似度。两个空集判为 0（而不是 1）—— 无信息不等于完全匹配 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
