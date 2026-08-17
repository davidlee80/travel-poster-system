import { createHash } from 'node:crypto';

import {
  IMAGE_PROMPT_VERSION,
  briefForRequirement,
  imageSizeFor,
  renderNegativePrompt,
  renderPrompt,
} from '@tps/assets';
import type { AssetsRepository, AssetCandidateRow } from '@tps/db';
import { imageWarningCode, type ImageClient } from '@tps/llm';
import type { AssetLock } from '@tps/queue';
import {
  GenerationMetadataSchema,
  SCHEMA_VERSIONS,
  type AssetRequirementItem,
  type AssetWarningCode,
  type LicenseType,
  type RepresentationType,
  type ResolvedAsset,
} from '@tps/schemas';
import type { UserType } from '@tps/shared';

import type { AiImageBudget } from '../ai-budget.js';
import { aiImageTotal } from '../asset-metrics.js';
import type { IngestDeps } from '../ingest.js';
import { ingestAsset } from '../ingest.js';

/**
 * ai-generator resolver（TP-4-02/03/06，设计稿 9.3～9.5、11.x、13.8、19.5）。
 *
 * 十八章降级链的第 1 级 —— P3 留空的那一级：
 * ```text
 * 0  缓存键命中 / 素材库匹配
 * 1  授权图源（V1 不接）→ **AI 生成**      ← 本文件
 * 2  默认占位图 / 文字路线
 * 3  跳过（模板隐藏槽位）
 * ```
 *
 * ## 同键并发只生成一次，其余等结果（TP-4-06）
 *
 * ```text
 * 拿到 lock:asset:{cache_key}  → 生成 → 后处理 → 上传 → 落库 → AI_GENERATION
 * 没拿到                        → 轮询 findByCacheKey 直到对方落库 → CACHE_HIT
 *                               → 等待超时 → 返回 null（交给下一层降级）
 * ```
 *
 * 等待而不是直接降级是 13.8 明确要求的（「其余等待结果」）：14 天归入
 * 3 个主题桶时，8 天并发解析里有 5 天落同一个键 —— 直接降级会让那 4 天
 * 拿到渐变背景，而它们要的图在几秒后就存在了。
 *
 * ## 11.3 的第五条在这里强制
 *
 * 「不把 AI 景点图标记成真实照片」：`representation_type` 硬编码为
 * `ILLUSTRATIVE`，不从任何输入取值。数据库还有一道
 * `assets_ai_must_be_illustrative`。两道是有意的冗余 —— 这一条一旦破，
 * 用户会把 AI 画的景点当成实拍照片去规划行程。
 *
 * ## 失败一律返回 null，从不抛错
 *
 * 16.3：素材类错误全部非阻断。AI 是**兜底路径**，它失败时下面还有占位图。
 * 抛错会让 resolve-assets 的槽位级 catch 记一条误导性的
 * `ASSET_LIBRARY_MISS`，而真实原因（超时 / 熔断 / 额度耗尽）会丢掉。
 * 因此原因通过 `warnings` 显式回传。
 */

export interface AiGeneratorDeps extends IngestDeps {
  readonly assets: AssetsRepository;
  readonly image: ImageClient;
  readonly assetLock: AssetLock;
  readonly budget: AiImageBudget;
  /** 21.2 措施二：20 秒。由配置传入，不在这里硬编码（可下调，不可上调） */
  readonly imageTimeoutMs: number;
  /**
   * `travel_ai_image_total` 的 `user_type` 标签（21.3 的 R-13 通用维度）。
   *
   * 它是 TP-4-17 的验证依据：「匿名任务
   * `travel_ai_image_total{user_type="ANONYMOUS"}` = 0，且仍能拿到 Hero」。
   * 少了这个标签，那条断言就无法表达 —— 而 `user_id` 是禁用标签（21.3）。
   */
  readonly userTypeLabel: UserType;
  readonly now?: () => number;
}

export interface AiGenerateOutcome {
  readonly resolved: ResolvedAsset | null;
  /** 13.7 的告警码。进 `generation_jobs.warnings`，不作为错误返回 */
  readonly warnings: readonly AssetWarningCode[];
}

/** 等待他人生成完成的上限。比 AI 超时（20 秒）多 2 秒，覆盖后处理与落库 */
export const AI_WAIT_TIMEOUT_MS = 22_000;

/** 轮询间隔。250 毫秒是「不给数据库压力」与「不白等」之间的折中 */
const AI_POLL_INTERVAL_MS = 250;

const NO_RESULT: AiGenerateOutcome = { resolved: null, warnings: [] };

/**
 * 由缓存键派生种子，而不是用随机数。
 *
 * 二十章要求 `seed` 与 `prompt_template_version` 一起「保证产物可复现」。
 * 随机种子记下来只能复现**那一次**；由键派生则意味着「同一个缓存键
 * 永远对应同一个种子」—— 排查「为什么这张图不对」时，只要键还在，
 * 就能原样重放一次请求，不需要先去库里翻出当时的种子。
 */
export function seedForCacheKey(cacheKey: string): number {
  // 取 6 个十六进制位（< 2^24），避免超出部分供应商对 seed 的取值范围
  return Number.parseInt(createHash('sha256').update(cacheKey).digest('hex').slice(0, 6), 16);
}

export async function resolveByAi(
  deps: AiGeneratorDeps,
  item: AssetRequirementItem,
  cacheKey: string | null,
): Promise<AiGenerateOutcome> {
  const brief = briefForRequirement(item);
  if (brief === null || cacheKey === null) {
    /*
     * 不可生成的槽位（ROUTE_MAP、缺实体名的景点、算不出缓存键）。
     * 不记 warning：这不是失败，而是「这一层压根不适用」，
     * 记下来会让 warnings 里充满噪音而真正的失败被埋掉。
     */
    return NO_RESULT;
  }

  const decision = await deps.budget.reserve(item.role);
  if (!decision.allowed) {
    /*
     * 21.4：额度与熔断都「记入 warnings，不报错」。
     * 用 ASSET_AI_GENERATION_FAILED 而不是新造一个码：13.7 的告警码集合是
     * 对外承诺的一部分，而具体原因在日志的 `reason` 字段里
     * （指标标签同样带它 —— `reason_code` 在白名单内）。
     */
    deps.logger.info(
      { role: item.role, reason_code: decision.reason },
      `跳过 AI 生成：${decision.reason}`,
    );
    aiImageTotal.inc({ outcome: 'skipped', role: item.role, user_type: deps.userTypeLabel });
    return { resolved: null, warnings: ['ASSET_AI_GENERATION_FAILED'] };
  }

  const acquired = await deps.assetLock.acquire(cacheKey);
  if (!acquired) {
    /*
     * 别人正在生成同一个键。归还本次预留 —— 我们不会真的调用模型，
     * 占着额度会让后面的槽位白白降级。
     */
    deps.budget.refund(item.role);
    const waited = await waitForCacheKey(deps, cacheKey);
    if (waited === null) {
      deps.logger.warn({ role: item.role, reason_code: 'AI_WAIT_TIMEOUT' }, '等待同键生成超时');
      aiImageTotal.inc({ outcome: 'deduplicated', role: item.role, user_type: deps.userTypeLabel });
      return { resolved: null, warnings: ['ASSET_AI_GENERATION_TIMEOUT'] };
    }
    aiImageTotal.inc({ outcome: 'deduplicated', role: item.role, user_type: deps.userTypeLabel });
    return { resolved: cachedAsset(item, waited), warnings: [] };
  }

  try {
    const size = imageSizeFor(
      item.visual_constraints.aspect_ratio,
      item.visual_constraints.min_width,
    );
    const seed = seedForCacheKey(cacheKey);

    const generated = await deps.image.generate({
      prompt: renderPrompt(brief),
      negativePrompt: renderNegativePrompt(brief),
      width: size.width,
      height: size.height,
      seed,
      timeoutMs: deps.imageTimeoutMs,
    });

    /*
     * 二十章的九个字段在这里一次写齐，并过一遍 schema。
     * 迁移 0005 的 `assets_ai_metadata_check` 只能验「非空」——
     * 验不了「有没有 seed」，而缺了 seed 这一行素材就不可复现。
     */
    const metadata = GenerationMetadataSchema.parse({
      generated_model: generated.model,
      model_version: generated.modelVersion,
      generated_at: new Date((deps.now ?? Date.now)()).toISOString(),
      prompt_template_version: IMAGE_PROMPT_VERSION,
      visual_brief: brief,
      negative_requirements: brief.negative_requirements,
      seed: generated.seed,
      cost_units: generated.costUnits,
      cache_key: cacheKey,
    });

    const ingested = await ingestAsset(deps, {
      bytes: generated.bytes,
      entityName: item.role === 'HERO_BACKGROUND' ? null : brief.theme,
      destinationName: brief.destination,
      destinationPlaceId: item.subject?.destination_place_id ?? null,
      title: brief.theme,
      styleTags: [...brief.palette],
      // 8.1：AI 生成物的授权类型是 AI_GENERATED，不是 PLATFORM_OWNED
      licenseType: 'AI_GENERATED',
      attributionText: null,
      licenseExpiresAt: null,
      sourceType: 'AI_GENERATED',
      // 11.3 第五条：硬编码，不从输入取
      representationType: 'ILLUSTRATIVE',
      originalUrl: null,
      cacheKey,
      generationMetadata: metadata,
      role: item.role,
      aspectRatio: item.visual_constraints.aspect_ratio,
      minWidth: item.visual_constraints.min_width,
    });

    if (ingested.kind === 'rejected') {
      /*
       * 11.2 的后处理拒了自己刚生成的图（分辨率或比例不符）。
       * 归还额度：这一张没进库，后面的槽位应该还能试。
       * 但**要记全局日计数** —— 供应商已经计费了，钱花掉了。
       */
      deps.budget.recordFailure(item.role);
      await deps.budget.commit();
      deps.logger.warn(
        { role: item.role, reason_code: ingested.rejection.reason },
        'AI 生成物未通过 11.2 后处理校验',
      );
      aiImageTotal.inc({ outcome: 'rejected', role: item.role, user_type: deps.userTypeLabel });
      return { resolved: null, warnings: ['ASSET_POSTPROCESS_FAILED'] };
    }

    await deps.budget.commit();

    const row = await deps.assets.findByCacheKey(cacheKey);
    if (row === null) {
      // 刚写进去就读不回来：只可能是键计算在写与读之间不一致（代码缺陷）
      deps.logger.error({ role: item.role }, 'AI 生成物落库后按缓存键读不回来');
      aiImageTotal.inc({ outcome: 'failed', role: item.role, user_type: deps.userTypeLabel });
      return { resolved: null, warnings: ['ASSET_AI_GENERATION_FAILED'] };
    }

    aiImageTotal.inc({
      outcome: ingested.created ? 'generated' : 'deduplicated',
      role: item.role,
      user_type: deps.userTypeLabel,
    });

    return {
      resolved: ingested.created
        ? aiAsset(item, row)
        : // 并发写入时对方先落库（唯一索引兜底）：从缓存视角这是一次命中
          cachedAsset(item, row),
      warnings: [],
    };
  } catch (error) {
    deps.budget.recordFailure(item.role);
    const code = imageWarningCode(error);
    deps.logger.warn({ role: item.role, error_code: code }, `AI 生成失败：${String(error)}`);
    aiImageTotal.inc({
      outcome: code === 'ASSET_AI_GENERATION_TIMEOUT' ? 'timeout' : 'failed',
      role: item.role,
      user_type: deps.userTypeLabel,
    });
    return { resolved: null, warnings: [code] };
  } finally {
    /*
     * 无论成败都释放锁。不释放的话等待方要空等 30 秒的 TTL ——
     * 而生成失败时它们本该立刻走占位图。
     */
    await deps.assetLock.release(cacheKey).catch(() => undefined);
  }
}

/** 轮询等待持锁方落库。返回 null 表示等待超时 */
async function waitForCacheKey(
  deps: AiGeneratorDeps,
  cacheKey: string,
): Promise<AssetCandidateRow | null> {
  const now = deps.now ?? Date.now;
  const deadline = now() + AI_WAIT_TIMEOUT_MS;

  for (;;) {
    const row = await deps.assets.findByCacheKey(cacheKey);
    if (row !== null) return row;
    if (now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, AI_POLL_INTERVAL_MS));
  }
}

function assetFrom(
  item: AssetRequirementItem,
  row: AssetCandidateRow,
  strategy: 'AI_GENERATION' | 'CACHE_HIT',
): ResolvedAsset {
  const width = row.width ?? 1;
  const height = row.height ?? 1;

  return {
    schema_version: SCHEMA_VERSIONS.resolvedAsset,
    slot_id: item.slot_id,
    status: 'RESOLVED',
    asset: {
      asset_id: row.assetId,
      asset_type: 'IMAGE',
      source_type: 'AI_GENERATED',
      // 8.1 的 refine 也要求 AI_GENERATED ⇒ ILLUSTRATIVE
      representation_type: (row.representationType as RepresentationType) ?? 'ILLUSTRATIVE',
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
        type: (row.licenseType as LicenseType) ?? 'AI_GENERATED',
        attribution_required: false,
      },
    },
    resolution:
      strategy === 'CACHE_HIT'
        ? // 19.4：CACHE_HIT 的 score 恒为 1.0，且它是 0 级（没花钱）
          { strategy: 'CACHE_HIT', score: 1, fallback_level: 0 }
        : /*
           * AI 生成是十八章的第 1 级降级。score 取 1.0 而不是 10.1 的相似度：
           * 生成物是**按需求定制**的，与「从库里挑一张最像的」不是同一量纲，
           * 相似度评分对它没有意义。
           */
          { strategy: 'AI_GENERATION', score: 1, fallback_level: 1 },
  };
}

function aiAsset(item: AssetRequirementItem, row: AssetCandidateRow): ResolvedAsset {
  return assetFrom(item, row, 'AI_GENERATION');
}

function cachedAsset(item: AssetRequirementItem, row: AssetCandidateRow): ResolvedAsset {
  return assetFrom(item, row, 'CACHE_HIT');
}
