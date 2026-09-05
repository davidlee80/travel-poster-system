import {
  CANDIDATE_LIMIT,
  SELECTION_BUDGET_MS,
  scoreAsset,
  selectBestCandidate,
  semanticQueryText,
  type ScoringCandidate,
  type ScoringRequirement,
} from '@tps/assets';
import type { AssetCandidateRow, AssetsRepository } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import {
  SCHEMA_VERSIONS,
  type AssetRequirementItem,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';
import type { Logger } from '@tps/shared';

/**
 * local-library resolver（TP-3-09，设计稿 9.4/9.5 的第一层、十章、10.2）。
 *
 * 「平台已审核素材」是景点图与美食图的**首选来源**，也是 Hero 在缓存未命中
 * 时的第二层（9.3「相似主题缓存图」）。它的产出是 `fallback_level: 0` 的
 * `LOCAL_LIBRARY_MATCH`。
 *
 * ## 800 毫秒预算覆盖的是「检索 + 打分」整体
 *
 * 10.2 第 5 步的上限是**单槽位素材检索总耗时**，因此 deadline 在进入本函数
 * 时就确定，向量化与数据库查询都在这个预算内。只给打分设预算是自欺 ——
 * 慢的从来不是打分（纯计算），而是那两次 IO。
 *
 * ## 向量化失败不阻断
 *
 * 查询向量拿不到时，仓储会退化成按 `quality_score` 排序返回候选，
 * 而 `semantic_similarity` 对无向量素材按中性 0.5 计入（10.1）。
 * 结果是这一层仍然可用，只是语义项失去区分度 —— 比直接跳到 AI 生成好：
 * 后者慢 40 倍且要花钱。
 */

export interface LocalLibraryDeps {
  readonly assets: AssetsRepository;
  readonly embedding: EmbeddingClient;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface LocalLibraryOptions {
  /** 绝对截止时刻（毫秒）。缺省为 `now() + 800` */
  readonly deadline?: number;
  readonly candidateLimit?: number;
}

export type LocalLibraryOutcome =
  | { readonly kind: 'hit'; readonly resolved: ResolvedAsset; readonly score: number }
  | {
      readonly kind: 'miss';
      /** 最好的候选分数（没有候选时为 null），供打点判断「差多少」 */
      readonly bestScore: number | null;
      readonly reason: 'empty' | 'below_threshold' | 'timeout';
    };

/** 需求 → 打分输入。ROUTE_MAP 不走素材库（9.2），由调用方保证不传进来 */
export function toScoringRequirement(item: AssetRequirementItem): ScoringRequirement {
  const subject = item.subject;
  return {
    role: item.role,
    entityName: subject?.entity_name ?? null,
    entityPlaceId: subject?.entity_place_id ?? null,
    destinationName: subject?.destination ?? '',
    destinationPlaceId: subject?.destination_place_id ?? null,
    aspectRatio: item.visual_constraints.aspect_ratio,
    minWidth: item.visual_constraints.min_width,
  };
}

function toScoringCandidate(row: AssetCandidateRow): ScoringCandidate {
  return {
    assetId: row.assetId,
    entityName: row.entityName,
    destinationName: row.destinationName,
    destinationPlaceId: row.destinationPlaceId,
    width: row.width,
    aspectRatio: row.aspectRatio,
    qualityScore: row.qualityScore,
    licenseType: row.licenseType as LicenseType,
    attributionRequired: row.attributionText !== null && row.attributionText.length > 0,
    cosine: row.cosine,
  };
}

/**
 * 缺尺寸或缺 MIME 的行**在打分前剔除**。
 *
 * 它们不是「分低」而是**不可用**：ResolvedAsset 要求正整数宽高
 * （模板要按比例占位，17.3 的溢出检测也依赖它）。而分辨率项只占 0.05 权重，
 * 一行缺宽高仍可能拿到 0.7 分被采用 —— 然后在构造 ResolvedAsset 时炸掉，
 * 或者更糟：被当成 0×0 渲染成一条缝。
 */
function isUsable(row: AssetCandidateRow): boolean {
  return row.width !== null && row.height !== null && row.mimeType !== null;
}

export function toResolvedAsset(
  slotId: string,
  row: AssetCandidateRow,
  score: number,
): ResolvedAsset {
  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: slotId,
    status: 'RESOLVED',
    asset: {
      asset_id: row.assetId,
      asset_type: row.assetType === 'SVG' ? 'SVG' : 'IMAGE',
      source_type:
        row.sourceType === 'AI_GENERATED'
          ? 'AI_GENERATED'
          : row.sourceType === 'LICENSED_SOURCE'
            ? 'LICENSED_SOURCE'
            : 'PLATFORM_LIBRARY',
      representation_type: row.representationType as RepresentationType,
      mime_type: row.mimeType ?? 'application/octet-stream',
      urls: { original: row.storageUrl, thumbnail: row.thumbnailUrl },
      width: row.width ?? 1,
      height: row.height ?? 1,
      aspect_ratio: row.aspectRatio ?? 1,
      metadata: {
        entity_name: row.entityName,
        destination: row.destinationName,
        style_tags: [...row.styleTags],
      },
      license: {
        type: row.licenseType as LicenseType,
        attribution_required: row.attributionText !== null && row.attributionText.length > 0,
        attribution_text: row.attributionText,
      },
    },
    resolution: { strategy: 'LOCAL_LIBRARY_MATCH', score, fallback_level: 0 },
  };
}

export async function resolveFromLocalLibrary(
  deps: LocalLibraryDeps,
  item: AssetRequirementItem,
  options: LocalLibraryOptions = {},
): Promise<LocalLibraryOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = options.deadline ?? now() + SELECTION_BUDGET_MS;
  const requirement = toScoringRequirement(item);

  let embedding: number[] | null = null;
  try {
    const query = semanticQueryText({
      role: item.role,
      entityName: requirement.entityName,
      destination: requirement.destinationName,
      styleTags: item.subject?.entities ?? null,
    });
    const [vector] = await deps.embedding.embed([query]);
    embedding = vector ?? null;
  } catch (error) {
    // ASSET_LIBRARY_MISS 之前的一步降级：无向量也要继续检索（见文件头）
    deps.logger.warn(
      { role: item.role },
      `查询向量化失败，本次检索退化为按质量排序：${String(error)}`,
    );
  }

  if (now() >= deadline) {
    return { kind: 'miss', bestScore: null, reason: 'timeout' };
  }

  const rows = await deps.assets.findCandidates({
    embedding,
    assetType: 'IMAGE',
    entityName: requirement.entityName,
    destinationPlaceId: requirement.destinationPlaceId,
    destinationName: requirement.destinationName,
    limit: options.candidateLimit ?? CANDIDATE_LIMIT,
    // 真实实现忽略它；fake 编排按它路由（见 FindCandidatesQuery.role）
    role: item.role,
  });

  const usable = rows.filter(isUsable);
  if (usable.length < rows.length) {
    deps.logger.warn(
      { role: item.role },
      `素材库有 ${rows.length - usable.length} 行缺尺寸或 MIME，已剔除（入库管道缺陷）`,
    );
  }

  const byId = new Map(usable.map((row) => [row.assetId, row]));
  const { outcome } = selectBestCandidate(requirement, usable.map(toScoringCandidate), {
    now,
    deadline,
    ...(options.candidateLimit === undefined ? {} : { candidateLimit: options.candidateLimit }),
  });

  if (outcome.kind === 'accepted') {
    const row = byId.get(outcome.best.candidate.assetId);
    if (row !== undefined) {
      return {
        kind: 'hit',
        resolved: toResolvedAsset(item.slot_id, row, outcome.best.score.final),
        score: outcome.best.score.final,
      };
    }
  }

  return {
    kind: 'miss',
    bestScore: outcome.best?.score.final ?? null,
    reason:
      outcome.reason === 'empty'
        ? 'empty'
        : outcome.reason === 'timeout'
          ? 'timeout'
          : 'below_threshold',
  };
}

/** 单独导出供测试与报表使用：对一批候选逐一打分（不做终止判定） */
export function scoreCandidates(
  item: AssetRequirementItem,
  rows: readonly AssetCandidateRow[],
): { readonly assetId: string; readonly score: number }[] {
  const requirement = toScoringRequirement(item);
  return rows
    .filter(isUsable)
    .map((row) => ({
      assetId: row.assetId,
      score: scoreAsset(requirement, toScoringCandidate(row)).final,
    }))
    .sort((a, b) => b.score - a.score);
}
