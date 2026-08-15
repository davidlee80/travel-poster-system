/**
 * 向量化客户端（TP-2-21，设计稿 15.2、3.2.4）。
 *
 * ## 为什么 V1 默认用本地哈希向量器，而不是模型供应商
 *
 * 全局历史检索（3.2.4）的过滤条件已经很强：**同 `destination.place_id`**
 * 且 **`total_days` 在 ±3 天内**。向量只负责在这个已经很窄的候选集里
 * 做相关性排序 —— 「杭州 5 天、运河主题」与「杭州 4 天、西湖主题」哪个更像
 * 当前需求。这个层次的判断，词汇重合度（共同的 POI 名、主题词）已经够用。
 *
 * 换来的是三件具体的东西：
 *   1. 检索链路（含列级 GRANT 隔离、超时、Top 5 排序）**可以在没有任何
 *      外部凭据的情况下端到端测试** —— 否则 CI 里这条链路只能靠 mock，
 *      而 mock 掉的恰好是「向量维度对不对」「HNSW 索引用没用上」这些
 *      只有真向量才能验证的事；
 *   2. 生成一次计划不产生额外的按调用计费；
 *   3. 供应商不可用时检索降级为词汇相似而不是整体失败。
 *
 * 接口保持一致，接真实供应商时只换实现。**换实现必须重算全部历史向量** ——
 * 两种向量空间不可比较，混在一张表里会让余弦阈值失去意义。
 */

/** 与 `travel_plan_versions.plan_embedding VECTOR(1536)` 一致 */
export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingClient {
  /** 写入 `travel_plan_versions.llm_model` 一类字段，用于判断向量是否可比 */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** FNV-1a 32 位。够散且无依赖 */
function fnv1a(text: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 切词：ASCII 单词 + 中文**双字**滑窗。
 *
 * 中文按双字而不是单字：单字「西」「湖」「杭」「州」在任何一份杭州计划里都
 * 高频出现，用单字会让两份毫无关系的杭州计划也非常相似，0.75 的阈值
 * （3.2.4）就失去筛选能力。双字保留了「西湖」「运河」「灵隐」这类实际的
 * 语义单元。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();

  const words = normalized.match(/[a-z0-9]+/g);
  if (words !== null) tokens.push(...words);

  const cjk = normalized.match(/[㐀-䶿一-鿿]+/g);
  if (cjk !== null) {
    for (const run of cjk) {
      if (run.length === 1) {
        tokens.push(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * 哈希技巧（hashing trick）向量器。
 *
 * 带**符号**而不是纯计数：纯计数产出的向量全为非负，任意两段中文文本的
 * 余弦都偏高（常用词天然重合），0.75 的阈值会几乎全部命中。
 * 随机符号让不相关文本的余弦围绕 0 波动，阈值才真正有区分度。
 */
export function hashingVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const index = fnv1a(token, 0x811c9dc5) % dimensions;
    const sign = fnv1a(token, 0x9e3779b9) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不一致：${a.length} 与 ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * V1 默认实现。
 *
 * `model` 里带上维度：换维度等于换向量空间，而库里的旧行不会自动重算。
 * 把维度写进模型标识，让「这一行的向量是哪个空间算的」可查。
 */
export class LocalHashingEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions: number = EMBEDDING_DIMENSIONS) {
    this.dimensions = dimensions;
    this.model = `local-hashing-${dimensions}`;
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => hashingVector(text, this.dimensions)));
  }
}

/** pgvector 的字面量形式：`[0.1,0.2,...]` */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
