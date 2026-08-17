import { normalizeName, tokenize } from './normalize.js';

/**
 * `assets.search_text` 的构造（TP-3-06，设计稿十五章 + 10.1）。
 *
 * ## 为什么要预先切词
 *
 * 迁移 0005 的倒排索引是 `to_tsvector('simple', search_text)`，而 PostgreSQL
 * 内置分词器**没有中文支持**（`'chinese'` 配置在标准镜像上直接报错）。
 * `simple` 按空白切分，因此「杭州拱宸桥」整串会成为一个词元 ——
 * 搜「拱宸桥」召回不到。
 *
 * 解法是入库时就把中文切成二元组并用空格连接，让 `simple` 分词器
 * 拿到的已经是词。切分口径与 10.1 的 `entity_match` 完全一致（都用
 * `tokenize`）—— 两处不同会让「倒排召回的」与「打分认可的」不是同一批素材。
 *
 * ## 原文也保留
 *
 * 产物同时含原文（去分隔符后的形式）与二元组：原文让完整词的精确匹配
 * 仍然有效，二元组负责部分匹配。只留二元组会让「杭州」这种两字词
 * 与「杭州湾」的区分度下降。
 */
export interface SearchTextInput {
  readonly entityName?: string | null;
  readonly destinationName?: string | null;
  readonly title?: string | null;
  readonly styleTags?: readonly string[] | null;
}

export function buildSearchText(input: SearchTextInput): string {
  const sources = [
    input.entityName ?? '',
    input.destinationName ?? '',
    input.title ?? '',
    ...(input.styleTags ?? []),
  ].filter((value) => value.trim().length > 0);

  const parts: string[] = [];
  for (const source of sources) {
    const normalized = normalizeName(source);
    if (normalized.length > 0) parts.push(normalized);
    parts.push(...tokenize(source));
  }

  // 去重后用空格连接：重复词元不改变 tsvector 的召回，只让列变长
  return [...new Set(parts)].join(' ');
}
