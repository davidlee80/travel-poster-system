import { createHash } from 'node:crypto';

import { semanticQueryText, themeBucket } from '@tps/assets';
import type { LicensedSourceCandidate, LicensedSourceClient } from '@tps/llm';
import { SourceMetadataSchema, type AssetRequirementItem } from '@tps/schemas';

import { ingestAsset, type IngestDeps } from './ingest.js';

/**
 * 9.6 搜索图自动入库流水线（TP-6-04/05，设计稿 9.6 的 R-46/R-47）。
 *
 * ```text
 * 搜索命中
 *   → 逐候选：
 *       license_type 为空 → 丢弃（不下载）
 *       声明的 MIME 不在白名单 → 丢弃（不下载）
 *       下载原图 → 失败即换下一个
 *       算 content_hash（原图字节 SHA-256）
 *       指纹已在库 → 标签并集合并，复用该行（R-47，零上传）
 *       11.2 后处理（含 quality_score < 0.3 拒收）
 *       上传 + 写 assets（source_type='LICENSED_SOURCE'，source_metadata 必填）
 *   → 本次请求即用；后续请求按十章评分从库内命中，不再外呼
 * ```
 *
 * ## 「用完即弃」是被明确禁止的
 *
 * 9.6：「搜索命中后**必须走完入库流水线才能使用**」。直接把图源的 URL 写进
 * ViewModel 有三个问题：图源的直链会过期（而 ViewModel 永久保存，19.3）、
 * 每次请求都要重新搜一遍（成本与时延都白付）、下架通道失效
 * （`assets.status` 管不到不在库里的图）。
 *
 * ## 顺序：便宜的判定在前
 *
 * 合规与 MIME 两道门禁在**下载之前** —— 它们只看检索响应里的字段。
 * 反过来的话，一个 license 为空的候选会白下载几百 KB 再被丢掉，
 * 而 9.6 的单任务 8 次搜索里这种候选可能占多数（CC0 源里混着未标注的图）。
 *
 * 指纹去重在**后处理之前**：转码与缩略图是这条链上最贵的两步，
 * 而指纹相同意味着后处理结果必然相同（见 `processImage` 的
 * QUALITY_TOO_LOW 分支注释里的同一论证）。
 *
 * ## 打标来源是 AssetRequirement，不是图像理解
 *
 * 9.6 的论证：「搜索词本来就是由槽位上下文构造的，命中图的标签沿用检索
 * 上下文即可闭环。引入视觉模型打标会多一次模型调用（成本、时延、
 * 一个新的失败点），换来的只是一种新的错标来源 —— 上下文标签错，
 * 至多是这张图检索排序不准；视觉模型标签错，会把图归到不相干的 POI 名下。」
 *
 * ## 失败一律返回 `assetId: null`，从不抛错
 *
 * 与 ai-generator 同一处理（16.3：素材类错误全部非阻断）。唯一的例外是
 * `search()` 本身的异常 —— 它会传播出去，因为调用方（licensed-source
 * resolver）要据此记 `recordFailure()` 与 `warnings`，而「候选全被丢弃」
 * 与「图源挂了」在预算判定上是两件事。
 */

/** 9.6：`quality_score` 低于此值不入库 */
export const SEARCH_QUALITY_FLOOR = 0.3;

/**
 * MIME 白名单。
 *
 * 只有三种常见位图。**SVG 不在其中**：外部 SVG 可以含 `<script>` 与外链
 * 资源，而素材 URL 会被直接嵌进导出页面并由 Chromium 渲染（17.x）。
 * 平台自己生成的路线图 SVG 走的是另一条路（9.2，不经这条流水线）。
 */
export const ALLOWED_SEARCH_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * 一次搜索最多试几个候选。
 *
 * 5 而不是 10.2 的 Top 30：那个数是**库内**检索的候选数（纯数据库查询，
 * 零外呼）。这里每个候选都可能意味着一次下载，而 9.6 的单槽位预算里
 * 一次搜索加最多 5 次下载已经接近 5 秒超时。
 */
export const SEARCH_CANDIDATE_LIMIT = 5;

/** 逐候选被丢弃的原因。进日志与指标，不进 `warnings`（那一层只关心「这一槽有没有图」） */
export type SearchRejectionReason =
  | 'LICENSE_MISSING'
  | 'MIME_NOT_ALLOWED'
  | 'DOWNLOAD_FAILED'
  | 'CONTENT_RETIRED'
  | 'POSTPROCESS_REJECTED'
  | 'QUALITY_TOO_LOW';

export interface SearchIngestDeps extends IngestDeps {
  readonly search: LicensedSourceClient;
  /** 9.6 的 5 秒。由配置传入，不在这里硬编码 */
  readonly searchTimeoutMs: number;
  readonly now?: () => number;
}

export interface SearchIngestOutcome {
  /** 入库或复用到的素材。全部候选被丢弃时为 null */
  readonly assetId: string | null;
  /** true = 新入库一行；false = 命中指纹后复用既有行（R-47） */
  readonly created: boolean;
  /** 是否真的调用了图源（算不出检索词时为 false —— 那不该计入配额） */
  readonly searched: boolean;
  readonly rejections: readonly SearchRejectionReason[];
}

/**
 * 检索词。
 *
 * 复用 `semanticQueryText` 而不是另写一套：库内检索的查询向量就是用它算的
 * （`local-library.ts`）。两处用不同的词会让「库里搜不到所以去外面搜」
 * 变成「用不同的词各搜一次」—— 于是外部命中的图入库后，
 * 下次库内检索仍然找不到它。
 */
export function buildSearchQueryText(item: AssetRequirementItem): string | null {
  // 9.2：路线图是程序生成的 SVG，没有可搜索的对象
  if (item.role === 'ROUTE_MAP') return null;

  const subject = item.subject;
  if (subject === null || subject === undefined) return null;

  const text = semanticQueryText({
    role: item.role,
    entityName: subject.entity_name ?? null,
    destination: subject.destination,
    styleTags: subject.entities ?? null,
  }).trim();

  return text.length === 0 ? null : text;
}

export async function ingestSearchResult(
  deps: SearchIngestDeps,
  item: AssetRequirementItem,
  cacheKey: string | null,
): Promise<SearchIngestOutcome> {
  const queryText = buildSearchQueryText(item);
  if (queryText === null) {
    return { assetId: null, created: false, searched: false, rejections: [] };
  }

  const candidates = await deps.search.search(
    {
      text: queryText,
      aspectRatio: item.visual_constraints.aspect_ratio,
      minWidth: item.visual_constraints.min_width,
      limit: SEARCH_CANDIDATE_LIMIT,
    },
    deps.searchTimeoutMs,
  );

  const rejections: SearchRejectionReason[] = [];

  for (const candidate of candidates.slice(0, SEARCH_CANDIDATE_LIMIT)) {
    const outcome = await tryCandidate(deps, item, cacheKey, queryText, candidate);
    if (outcome.kind === 'rejected') {
      rejections.push(outcome.reason);
      continue;
    }
    return {
      assetId: outcome.assetId,
      created: outcome.created,
      searched: true,
      rejections,
    };
  }

  return { assetId: null, created: false, searched: true, rejections };
}

type CandidateOutcome =
  | { readonly kind: 'rejected'; readonly reason: SearchRejectionReason }
  | { readonly kind: 'accepted'; readonly assetId: string; readonly created: boolean };

async function tryCandidate(
  deps: SearchIngestDeps,
  item: AssetRequirementItem,
  cacheKey: string | null,
  queryText: string,
  candidate: LicensedSourceCandidate,
): Promise<CandidateOutcome> {
  // ── 门禁一：授权（9.6 / FR-3.4.5）。在下载之前 ──
  const licenseType = candidate.licenseType;
  if (licenseType === null) {
    deps.logger.info(
      { role: item.role, reason_code: 'LICENSE_MISSING' },
      '搜索候选没有可映射的授权类型，已丢弃',
    );
    return { kind: 'rejected', reason: 'LICENSE_MISSING' };
  }

  // ── 门禁二：声明的 MIME。同样在下载之前 ──
  const declared = candidate.mimeType;
  if (
    declared !== null &&
    !ALLOWED_SEARCH_MIME.includes(declared as (typeof ALLOWED_SEARCH_MIME)[number])
  ) {
    deps.logger.info(
      { role: item.role, reason_code: 'MIME_NOT_ALLOWED' },
      `搜索候选的 MIME 不在白名单：${declared}`,
    );
    return { kind: 'rejected', reason: 'MIME_NOT_ALLOWED' };
  }

  // ── 下载 ──
  let bytes: Uint8Array;
  try {
    bytes = await deps.search.download(candidate, deps.searchTimeoutMs);
  } catch (error) {
    deps.logger.warn(
      { role: item.role, reason_code: 'DOWNLOAD_FAILED' },
      `搜索候选下载失败：${String(error)}`,
    );
    return { kind: 'rejected', reason: 'DOWNLOAD_FAILED' };
  }

  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const tags = styleTagsFor(item, candidate);

  // ── 门禁三、四与入库（11.2 后处理 + 质量下限）──
  const nowMs = (deps.now ?? Date.now)();
  const ingested = await ingestAsset(deps, {
    bytes,
    entityName: item.role === 'HERO_BACKGROUND' ? null : (item.subject?.entity_name ?? null),
    destinationName: item.subject?.destination ?? null,
    destinationPlaceId: item.subject?.destination_place_id ?? null,
    title: item.subject?.theme ?? null,
    styleTags: tags,
    licenseType,
    attributionText: candidate.attributionText,
    licenseExpiresAt: candidate.licenseExpiresAt,
    sourceType: 'LICENSED_SOURCE',
    /*
     * 9.4：搜索到的是**真实照片**，因此 PHOTOGRAPHIC。
     * 与 AI 生成物硬编码 ILLUSTRATIVE 是同一处理的两面 ——
     * 这个值决定页面上要不要显示「示意图」（二十章的披露要求），
     * 不能从任何输入取。
     */
    representationType: 'PHOTOGRAPHIC',
    originalUrl: candidate.originalUrl,
    cacheKey,
    generationMetadata: null,
    sourceMetadata: SourceMetadataSchema.parse({
      provider: candidate.provider,
      original_url: candidate.originalUrl,
      search_query: queryText,
      license: licenseType,
      license_expires_at: candidate.licenseExpiresAt?.toISOString() ?? null,
      retrieved_at: new Date(nowMs).toISOString(),
    }),
    role: item.role,
    aspectRatio: item.visual_constraints.aspect_ratio,
    minWidth: item.visual_constraints.min_width,
    contentHash,
    minQualityScore: SEARCH_QUALITY_FLOOR,
  });

  if (ingested.kind === 'rejected') {
    const reason: SearchRejectionReason =
      ingested.rejection.reason === 'QUALITY_TOO_LOW' ? 'QUALITY_TOO_LOW' : 'POSTPROCESS_REJECTED';
    deps.logger.info(
      { role: item.role, reason_code: ingested.rejection.reason },
      '搜索候选未通过 11.2 后处理或质量下限，已丢弃',
    );
    return { kind: 'rejected', reason };
  }

  return { kind: 'accepted', assetId: ingested.assetId, created: ingested.created };
}

/**
 * 风格标签。
 *
 * 三类来源，全部取自上下文：
 *   - `visual_constraints.style` 的小写形式（与 19.2 的缓存键同一归一，
 *     因此库内检索的风格匹配与键复用看到的是同一个词）；
 *   - `subject.theme` 归桶后的桶名（19.1 的 12 个主题桶）；
 *   - `provider:<名字>` 标记 —— 用于「某个图源被下架时批量找出它的素材」。
 *     不放进 `source_metadata` 就够了吗？不够：那一列是 JSONB，
 *     按它筛要全表扫，而 `style_tags` 有 GIN 索引（经 `search_text`）。
 */
function styleTagsFor(
  item: AssetRequirementItem,
  candidate: LicensedSourceCandidate,
): readonly string[] {
  const tags = new Set<string>();

  const style = item.visual_constraints.style;
  if (style !== null && style !== undefined) tags.add(style.toLowerCase());

  const theme = item.subject?.theme;
  if (theme !== null && theme !== undefined) tags.add(themeBucket(theme));

  tags.add(`provider:${candidate.provider}`);

  return [...tags];
}
