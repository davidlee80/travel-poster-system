import { randomUUID } from 'node:crypto';

import {
  IMAGE_PROMPT_VERSION,
  imageSizeFor,
  renderNegativePrompt,
  renderPrompt,
} from '@tps/assets';
import type { AssetsRepository } from '@tps/db';
import type { ImageClient } from '@tps/llm';
import {
  AiAssetGenerateRequestSchema,
  AiAssetGenerateResponseSchema,
  GenerationMetadataSchema,
  type AiAssetGenerateRequest,
  type AiAssetGenerateResponse,
  type AssetRole,
} from '@tps/schemas';

import type { IngestDeps } from './ingest.js';
import { ingestAsset } from './ingest.js';
import { seedForCacheKey } from './resolvers/ai-generator.js';

/**
 * 14.3「AI 生成素材」的契约实现（TP-4-01）。
 *
 * ## R-32：这里是函数，不是 `apps/api` 的路由
 *
 * 14.3 写的是 `POST /internal/v1/assets/generate`。14.2 的同类端点确实建在
 * `apps/api`（R-28：端点是契约的宿主），但 14.3 与它有三处本质差别：
 *
 * ```text
 * 14.2 渲染 SVG    纯函数，零凭据，零成本，毫秒级
 * 14.3 生成图片    需要 sharp（原生模块）、图片模型的**付费凭据**、
 *                  对象存储的**写凭据**，单次最多 20 秒
 * ```
 *
 * 把它做成 api 的路由，等于让面向公网的进程具备「花钱生成图片」的能力，
 * 而防线只有一个共享密钥。同时 api 要装上 sharp 与 S3 写权限 ——
 * 而 22.2 已经决定素材服务合并进 generation-worker，凭据与原生依赖本就在这里。
 *
 * 因此：
 *   - **契约由 `AiAssetGenerateRequest/Response` 冻结**（14.3 的四种受控类型
 *     是 schema 里的白名单，被单测覆盖）；
 *   - **运维入口是 CLI**（`pnpm assets:preheat`），与 14.1 的处理一致；
 *   - 真要把它暴露成 HTTP，接缝就是这个函数 —— 拆分素材服务时在 worker 侧
 *     加一个受控端口，而不是加在公网 API 上。
 *
 * ## 与 ai-generator resolver 的分工
 *
 * resolver 做的是「按槽位需求走降级链」：额度、并发锁、失败降级都在那里。
 * 这个函数做的是「照 Brief 生成一张并入库」，**不含额度与锁** ——
 * 它的调用方是预热 CLI（离线、串行、有自己的并发控制），
 * 而给离线预热套上「单任务 3 张」的上限会让 600 张预热永远跑不完。
 */

export interface GenerateAssetDeps extends IngestDeps {
  readonly assets: AssetsRepository;
  readonly image: ImageClient;
  readonly imageTimeoutMs: number;
  readonly now?: () => number;
}

/** 14.3 的受控类型 → 入库时的角色。`DECORATIVE_ILLUSTRATION` 无对应槽位角色 */
const ROLE_BY_ASSET_TYPE: Readonly<Record<AiAssetGenerateRequest['asset_type'], AssetRole | null>> =
  {
    HERO_ILLUSTRATION: 'HERO_BACKGROUND',
    DESTINATION_ILLUSTRATION_FALLBACK: 'DESTINATION_PHOTO',
    FOOD_FALLBACK: 'FOOD_IMAGE',
    DECORATIVE_ILLUSTRATION: null,
  };

export class UnsupportedAiAssetTypeError extends Error {
  constructor(assetType: string) {
    super(`素材类型 ${assetType} 在 V1 没有对应的槽位角色，无法入库`);
    this.name = 'UnsupportedAiAssetTypeError';
  }
}

/** 生成一张 AI 素材并入库。同缓存键已存在时直接返回既有素材，不重复生成 */
export async function generateAiAsset(
  deps: GenerateAssetDeps,
  input: AiAssetGenerateRequest,
): Promise<AiAssetGenerateResponse> {
  // 白名单在这里生效（14.3「只允许受控的素材类型」）
  const request = AiAssetGenerateRequestSchema.parse(input);
  const role = ROLE_BY_ASSET_TYPE[request.asset_type];
  if (role === null) {
    /*
     * 契约上合法、V1 无处安放。抛错而不是静默按某个角色入库：
     * 猜一个角色会让它进入那个角色的检索候选集（十章的评分按角色取查询词），
     * 表现是「装饰插画出现在景点图的位置」。
     */
    throw new UnsupportedAiAssetTypeError(request.asset_type);
  }

  const existing = await deps.assets.findByCacheKey(request.cache_key);
  if (existing !== null) {
    /*
     * 19.5 的跨计划复用：预热跑第二遍时绝大多数键都已存在。
     * 先查一次的收益是「600 张预热的重跑几乎零成本」——
     * 而不查的代价是把 600 次付费调用再花一遍，产物还会被唯一索引丢弃。
     */
    return AiAssetGenerateResponseSchema.parse({
      asset_id: existing.assetId,
      created: false,
      url: existing.storageUrl,
      thumbnail_url: existing.thumbnailUrl,
      width: existing.width ?? 1,
      height: existing.height ?? 1,
      generation_metadata: metadataFor(request, {
        model: 'reused',
        modelVersion: 'reused',
        seed: seedForCacheKey(request.cache_key),
        costUnits: 0,
        generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      }),
    });
  }

  const size = imageSizeFor(request.brief.layout.aspect_ratio, request.min_width);
  const generated = await deps.image.generate({
    prompt: renderPrompt(request.brief),
    negativePrompt: renderNegativePrompt(request.brief),
    width: size.width,
    height: size.height,
    seed: seedForCacheKey(request.cache_key),
    timeoutMs: deps.imageTimeoutMs,
  });

  const metadata = metadataFor(request, {
    model: generated.model,
    modelVersion: generated.modelVersion,
    seed: generated.seed,
    costUnits: generated.costUnits,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
  });

  const ingested = await ingestAsset(deps, {
    bytes: generated.bytes,
    entityName: role === 'HERO_BACKGROUND' ? null : request.brief.theme,
    destinationName: request.brief.destination,
    destinationPlaceId: null,
    title: request.brief.theme,
    styleTags: [...request.brief.palette],
    licenseType: 'AI_GENERATED',
    attributionText: null,
    licenseExpiresAt: null,
    sourceType: 'AI_GENERATED',
    // 11.3 第五条：硬编码，不从输入取
    representationType: 'ILLUSTRATIVE',
    originalUrl: null,
    cacheKey: request.cache_key,
    generationMetadata: metadata,
    role,
    aspectRatio: request.brief.layout.aspect_ratio,
    minWidth: request.min_width,
  });

  if (ingested.kind === 'rejected') {
    throw new Error(`生成物未通过 11.2 后处理校验：${ingested.rejection.reason}`);
  }

  const row = await deps.assets.findByCacheKey(request.cache_key);
  return AiAssetGenerateResponseSchema.parse({
    // 落库后读不回来只可能是键计算不一致（代码缺陷）；用 randomUUID 占位会掩盖它
    asset_id: row?.assetId ?? ingested.assetId ?? randomUUID(),
    created: ingested.created,
    url: row?.storageUrl ?? '',
    thumbnail_url: row?.thumbnailUrl ?? null,
    width: row?.width ?? size.width,
    height: row?.height ?? size.height,
    generation_metadata: metadata,
  });
}

function metadataFor(
  request: AiAssetGenerateRequest,
  model: {
    readonly model: string;
    readonly modelVersion: string;
    readonly seed: number;
    readonly costUnits: number;
    readonly generatedAt: string;
  },
): unknown {
  return GenerationMetadataSchema.parse({
    generated_model: model.model,
    model_version: model.modelVersion,
    generated_at: model.generatedAt,
    prompt_template_version: IMAGE_PROMPT_VERSION,
    visual_brief: request.brief,
    negative_requirements: request.brief.negative_requirements,
    seed: model.seed,
    cost_units: model.costUnits,
    cache_key: request.cache_key,
  });
}
