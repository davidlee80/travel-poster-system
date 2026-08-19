import type { AssetCandidateRow, AssetsRepository } from '@tps/db';
import { searchWarningCode, type LicensedSourceClient } from '@tps/llm';
import {
  SCHEMA_VERSIONS,
  type AssetRequirementItem,
  type AssetWarningCode,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';

import { assetSearchTotal } from '../asset-metrics.js';
import type { ImageSearchBudget } from '../search-budget.js';
import { ingestSearchResult, type SearchIngestDeps } from '../search-ingest.js';

/**
 * licensed-source resolver（TP-6-03，设计稿 9.3～9.6、21.4 的 R-45/R-46）。
 *
 * 十八章降级链的第 1 级**前半** —— P3 留空、P4 只填了后半（AI）的那一级：
 *
 * ```text
 * 0  缓存键命中 / 素材库匹配
 * 1  **授权图源搜索**（本文件）→ AI 生成（ai-generator.ts）
 * 2  默认占位图 / 文字路线
 * 3  跳过（模板隐藏槽位）
 * ```
 *
 * 三条链（Hero / 景点 / 美食）统一走这一层。9.6 的 R-45 指出：原本三类图里
 * 唯一跳过搜索直接进 AI 的恰是最贵的那张（Hero —— 尺寸最大、10～40 秒、
 * 成本最高），而搜索层的加入**不改变** 21.2 措施二的结论 ——
 * 预热命中（≥ 80%）仍是主路径，搜索只发生在「主题桶未命中且库内无同城
 * 同风格素材」的冷组合上，且命中一次即入库，同一冷组合全平台只搜一次。
 *
 * ## 与 ai-generator 的三处不同
 *
 * **没有同键锁。** ai-generator 用 `lock:asset:{cache_key}` 让同键并发只生成
 * 一次，其余等结果（13.8）。搜索层不需要：一次搜索 5 秒且 R-47 的指纹去重
 * 会让并发的第二个进程在**下载之后**发现图已在库，从而走合并分支 ——
 * 代价是一次多余的下载，而锁的代价是一次 Redis 往返加最长 22 秒的等待。
 * 冷组合的并发度本来就低（同一个 POI 在一个任务里通常只出现一次）。
 *
 * **失败会记 `recordFailure` 而不只是记 warning。** 9.6 的「连续失败 2 次即
 * 停用」是时延约束：图源挂掉时每个槽位都要等满 5 秒，而 14 天有几十个槽位。
 *
 * **成功不占身份额度。** 搜索命中入库为全平台共享资产，因此 9.6 规定匿名与
 * 注册同额（见 `search-budget.ts`）。
 *
 * ## 失败一律返回 null，从不抛错
 *
 * 16.3：素材类错误全部非阻断。原因通过 `warnings` 显式回传 ——
 * 抛错会让 resolve-assets 的槽位级 catch 记一条误导性的
 * `ASSET_LIBRARY_MISS`，而真实原因（超时 / 熔断 / 配额耗尽）会丢掉。
 */

export interface LicensedSourceLayerDeps {
  readonly search: LicensedSourceClient;
  /** 每任务一个实例（9.6 的单任务上限与连续失败都是任务内状态） */
  readonly searchBudget: ImageSearchBudget;
  /** 9.6 的 5 秒。由配置传入，不在这里硬编码（可下调，不可上调） */
  readonly searchTimeoutMs: number;
}

export interface LicensedSourceOutcome {
  readonly resolved: ResolvedAsset | null;
  /** 13.7 的告警码。进 `generation_jobs.warnings`，不作为错误返回 */
  readonly warnings: readonly AssetWarningCode[];
}

const NO_RESULT: LicensedSourceOutcome = { resolved: null, warnings: [] };

export type LicensedSourceResolverDeps = Omit<SearchIngestDeps, 'search' | 'searchTimeoutMs'> &
  LicensedSourceLayerDeps & {
    readonly assets: AssetsRepository;
  };

export async function resolveByLicensedSource(
  deps: LicensedSourceResolverDeps,
  item: AssetRequirementItem,
  cacheKey: string | null,
): Promise<LicensedSourceOutcome> {
  const decision = await deps.searchBudget.reserve(item.role);
  if (!decision.allowed) {
    if (decision.reason === 'ROLE_NOT_ELIGIBLE') {
      /*
       * `ROUTE_MAP`：这一层压根不适用。不记 warning ——
       * 记下来会让 warnings 里充满噪音而真正的失败被埋掉
       * （与 ai-generator 对不可生成槽位的同一处理）。
       */
      return NO_RESULT;
    }

    /*
     * 9.6：「超出跳过搜索层记 `warnings` 不报错」。
     * 具体原因在日志的 `reason_code` 与指标的 `outcome` 里 ——
     * 13.7 的告警码集合是对外承诺，不为内部原因新增取值。
     */
    deps.logger.info(
      { role: item.role, reason_code: decision.reason },
      `跳过授权图源搜索：${decision.reason}`,
    );
    assetSearchTotal.inc({ role: item.role, outcome: 'skipped' });
    return { resolved: null, warnings: ['ASSET_LICENSED_SOURCE_UNAVAILABLE'] };
  }

  let outcome;
  try {
    outcome = await ingestSearchResult(
      { ...deps, search: deps.search, searchTimeoutMs: deps.searchTimeoutMs },
      item,
      cacheKey,
    );
  } catch (error) {
    /*
     * 图源本身失败（超时 / 不可用）。**不重试** —— 9.6 明确「超时即降入
     * AI 层，不重试」：重试会把 5 秒变成 10 秒，而下一层（AI）本身要 20 秒。
     */
    deps.searchBudget.recordFailure();
    const code = searchWarningCode(error);
    const timedOut = error instanceof Error && error.name === 'ImageSearchTimeoutError';
    deps.logger.warn({ role: item.role, error_code: code }, `授权图源搜索失败：${String(error)}`);
    assetSearchTotal.inc({ role: item.role, outcome: timedOut ? 'timeout' : 'failed' });
    return { resolved: null, warnings: [code] };
  }

  if (!outcome.searched) {
    // 算不出检索词（缺主体）：归还预留，这一层不适用，不记 warning
    deps.searchBudget.refund();
    return NO_RESULT;
  }

  if (outcome.assetId === null) {
    /*
     * 搜到了但全部候选被入库门禁丢弃（或图源零命中）。
     *
     * 这**不算**图源故障 —— 图源工作正常，只是这个冷组合没有合规且够清晰的
     * 图。记 `recordSuccess` 而不是 `recordFailure`：否则连续两个冷组合
     * 无果就会把本任务的搜索层关掉，而后面的槽位可能搜得到。
     */
    deps.searchBudget.recordSuccess();
    deps.logger.info(
      { role: item.role, reason_code: outcome.rejections[0] ?? 'NO_CANDIDATE' },
      `授权图源无可用候选（丢弃 ${outcome.rejections.length} 个）`,
    );
    assetSearchTotal.inc({ role: item.role, outcome: 'rejected' });
    return { resolved: null, warnings: ['ASSET_LICENSED_SOURCE_UNAVAILABLE'] };
  }

  deps.searchBudget.recordSuccess();
  await deps.searchBudget.commit();

  /*
   * 按 ID 读回：落库后的尺寸、比例与对象 URL 只有数据库知道（11.2 会缩图
   * 与转码）。用 ID 而不是缓存键，因为键可以是 null —— 美食槽位缺菜名时
   * 19.2 算不出键（见 `resolve-assets.ts` 的 `cacheKeyFor`）。
   */
  const candidate = await deps.assets.findById(outcome.assetId);
  if (candidate === null) {
    /*
     * 刚入库就读不回来。与 ai-generator 的同一处理：只可能是键计算在写与读
     * 之间不一致（代码缺陷），用一个编造的 ResolvedAsset 掩盖它会让页面
     * 显示裂图而日志里什么都没有。
     */
    deps.logger.error({ role: item.role }, '搜索入库后按 ID 读不回来，降级到下一层');
    assetSearchTotal.inc({ role: item.role, outcome: 'failed' });
    return { resolved: null, warnings: ['ASSET_LICENSED_SOURCE_UNAVAILABLE'] };
  }

  assetSearchTotal.inc({
    role: item.role,
    outcome: outcome.created ? 'ingested' : 'deduplicated',
  });

  return { resolved: toResolvedAsset(item, candidate), warnings: [] };
}

function toResolvedAsset(item: AssetRequirementItem, row: AssetCandidateRow): ResolvedAsset {
  const width = row.width ?? 1;
  const height = row.height ?? 1;

  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    status: 'RESOLVED',
    asset: {
      asset_id: row.assetId,
      asset_type: 'IMAGE',
      source_type: 'LICENSED_SOURCE',
      // 9.4：搜索到的是真实照片。二十章的「示意图」披露因此不适用
      representation_type: (row.representationType as RepresentationType) ?? 'PHOTOGRAPHIC',
      mime_type: row.mimeType ?? 'image/webp',
      urls: { original: row.storageUrl, thumbnail: row.thumbnailUrl },
      width,
      height,
      aspect_ratio: row.aspectRatio ?? width / height,
      metadata: {
        entity_name: row.entityName,
        destination: row.destinationName,
        style_tags: [...row.styleTags],
      },
      license: {
        type: (row.licenseType as LicenseType) ?? 'LICENSED',
        attribution_required: row.attributionText !== null && row.attributionText.length > 0,
        attribution_text: row.attributionText,
      },
    },
    /*
     * 十八章的第 1 级。`score` 取 1.0 而不是 10.1 的相似度：搜索结果是
     * **按需求检索**到的（检索词由槽位上下文构造），与「从库里挑一张最像的」
     * 不是同一量纲 —— 与 AI_GENERATION 的同一处理。
     */
    resolution: { strategy: 'LICENSED_SOURCE_MATCH', score: 1, fallback_level: 1 },
  };
}
