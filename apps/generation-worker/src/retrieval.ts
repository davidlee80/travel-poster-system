import { RetrievalTimeoutError, type RetrievalRepository, type RetrievalSource } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import { normalizedRequestToEmbeddingText, parseRetrievalProjection } from '@tps/planning';
import type { NormalizedTravelRequest, RetrievalProjection } from '@tps/schemas';

import { retrievalReferenceTotal } from './plan-metrics.js';

/**
 * 全局历史参考的检索编排（TP-2-23、TP-2-24、TP-2-25，设计稿 3.2.4）。
 *
 * 仓储负责「怎么查」，这里负责「查什么、查不到怎么办」：
 *   - 3.2.4 的四个约束值（Top 5、余弦 0.75、±3 天、1.5 秒）在此定义；
 *   - 查不到、超时、没有 `place_id` 三种情形都**继续生成**，
 *     并把「无历史参考」记入 `assumptions`；
 *   - 每次检索按来源打点（21.3 的 `travel_retrieval_reference_total`）。
 *
 * 检索失败绝不能让任务失败：3.2.4 明确「超时按无参考继续」。
 * 历史参考是**提高质量的输入**，不是生成的前提 —— 空库时的首次生成
 * 必须成功，否则系统上线第一天就不可用（TP-2-24）。
 */

/** 3.2.4：候选数 Top 5（跨来源的总数） */
export const RETRIEVAL_LIMIT = 5;
/** 3.2.4：相似度下限，低于此值视为无参考 */
export const RETRIEVAL_MIN_SIMILARITY = 0.75;
/** 3.2.4：`total_days` 在 ±3 天内 */
export const RETRIEVAL_DAY_TOLERANCE = 3;
/** 3.2.4 / 21.2：耗时上限 1.5 秒 */
export const RETRIEVAL_TIMEOUT_MS = 1_500;

/**
 * 无参考时写入 `constraint_report.assumptions` 的条目（TP-2-24）。
 *
 * 3.2.4 要求这件事对用户可见。理由不是形式上的完整：有参考与无参考生成出的
 * 计划质量确实不同，而用户看到的两份计划外观完全一样。把「这次没有可参考的
 * 同类行程」说出来，用户才知道该多花点力气自己核对。
 */
export const NO_REFERENCE_ASSUMPTION = {
  code: 'NO_HISTORICAL_REFERENCE',
  text: '没有可参考的同类历史行程，这份计划完全按你的需求新生成。',
} as const;

export type RetrievalOutcomeKind = 'hit' | 'miss' | 'timeout';

export interface RetrievalReference {
  readonly projection: RetrievalProjection;
  readonly similarity: number;
  readonly source: RetrievalSource;
}

export interface RetrievalResult {
  readonly outcome: RetrievalOutcomeKind;
  /** 只包含形状校验通过的投影，可直接进 LLM 上下文 */
  readonly references: readonly RetrievalReference[];
  /** 需要写入计划的假设（无参考时非空） */
  readonly assumptions: readonly { readonly code: string; readonly text: string }[];
}

export interface RetrievalDeps {
  readonly repository: RetrievalRepository;
  readonly embedding: EmbeddingClient;
}

export interface RetrievalInput {
  readonly normalized: NormalizedTravelRequest;
  /** 3.2.4：排除本次请求自身产生的版本 */
  readonly excludePlanId?: string;
}

const ALL_SOURCES: readonly RetrievalSource[] = ['versions', 'knowledge'];

function record(outcome: RetrievalOutcomeKind, sources: readonly RetrievalSource[]): void {
  for (const source of sources) {
    retrievalReferenceTotal.inc({ outcome, source });
  }
}

function miss(): RetrievalResult {
  return { outcome: 'miss', references: [], assumptions: [NO_REFERENCE_ASSUMPTION] };
}

export async function retrieveReferences(
  deps: RetrievalDeps,
  input: RetrievalInput,
): Promise<RetrievalResult> {
  const placeId = input.normalized.destination_place_id;

  /*
   * 没有 place_id 就不检索。
   *
   * 3.2.4 的过滤条件第一项是「同 `destination.place_id`」，而用户手输的地名
   * 可能没有对应 place_id（见 TravelRequestUI 的 PlaceRefSchema）。
   * 退化成按名称匹配是不可接受的：「杭州」与「杭州市」会被判为不同城市，
   * 而不同省的同名地点（朝阳）会被判为同一个 —— 后者意味着把辽宁朝阳的
   * 行程当作北京朝阳的参考塞进上下文。宁可无参考。
   */
  if (placeId === undefined) {
    record('miss', ALL_SOURCES);
    return miss();
  }

  const [vector] = await deps.embedding.embed([normalizedRequestToEmbeddingText(input.normalized)]);
  if (vector === undefined) {
    record('miss', ALL_SOURCES);
    return miss();
  }

  let candidates;
  try {
    candidates = await deps.repository.findSimilar({
      embedding: vector,
      destinationPlaceId: placeId,
      totalDays: input.normalized.total_days,
      ...(input.excludePlanId !== undefined ? { excludePlanId: input.excludePlanId } : {}),
      minSimilarity: RETRIEVAL_MIN_SIMILARITY,
      limit: RETRIEVAL_LIMIT,
      dayTolerance: RETRIEVAL_DAY_TOLERANCE,
      timeoutMs: RETRIEVAL_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof RetrievalTimeoutError) {
      record('timeout', ALL_SOURCES);
      return { outcome: 'timeout', references: [], assumptions: [NO_REFERENCE_ASSUMPTION] };
    }
    /*
     * 其他错误往上抛。列权限被拒（隔离配置有问题）绝不能被当成「无参考」
     * 静默吞掉 —— 那会让一个配置事故表现为「检索效果不好」。
     */
    throw error;
  }

  /*
   * 逐条校验投影形状。库里可能有投影规则修订之前写入的行，
   * 解析失败就跳过 —— 把形状未知的 JSON 塞进 LLM 上下文，
   * 意味着它里面可能带着旧规则漏掉的敏感字段。
   */
  const references: RetrievalReference[] = [];
  for (const candidate of candidates) {
    const projection = parseRetrievalProjection(candidate.projection);
    if (projection === null) continue;
    references.push({
      projection,
      similarity: candidate.similarity,
      source: candidate.source,
    });
  }

  if (references.length === 0) {
    record('miss', ALL_SOURCES);
    return miss();
  }

  /*
   * 按来源分别打点：命中的来源记 hit，没贡献候选的记 miss。
   * 只记一个整体 outcome 会看不出「知识库到底有没有在发挥作用」——
   * 而 15.1 把匿名数据清理后的知识沉淀到 plan_knowledge，
   * 它是否真的被检索到是那套设计成立与否的唯一证据。
   */
  const hitSources = new Set(references.map((reference) => reference.source));
  for (const source of ALL_SOURCES) {
    retrievalReferenceTotal.inc({ outcome: hitSources.has(source) ? 'hit' : 'miss', source });
  }

  return { outcome: 'hit', references, assumptions: [] };
}
