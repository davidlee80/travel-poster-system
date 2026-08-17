import { randomUUID } from 'node:crypto';

import { buildSearchText, semanticQueryText } from '@tps/assets';
import type { AssetsRepository } from '@tps/db';
import type { EmbeddingClient } from '@tps/llm';
import {
  type AspectRatio,
  type AssetRole,
  type AssetSourceType,
  type LicenseType,
  type RepresentationType,
} from '@tps/schemas';
import type { ObjectStorage } from '@tps/storage';
import type { Logger } from '@tps/shared';

import { processImage, type ProcessImageRejection } from './processors/image.js';

/**
 * 素材入库管道（TP-3-06，设计稿 10.1、11.2 第 6～7 步、十五章）。
 *
 * ```text
 * 图片字节 + 元数据
 *   → 11.2 后处理（有效性 / 分辨率 / 比例 / WebP / 缩略图）
 *   → 上传对象存储（原图与缩略图两个对象）
 *   → 计算 search_text（倒排召回）与 embedding（向量召回）
 *   → 写 assets + asset_variants
 * ```
 *
 * ## 三个「离线算好」的列
 *
 * `quality_score`、`search_text`、`embedding` 全部在这里算完落库。
 * 10.1 明确 `quality_score` 「不在检索路径实时算」—— 检索路径有 800 毫秒
 * 预算（10.2），而拉普拉斯方差要解码整张图。同理 `search_text` 的分词与
 * `embedding` 的向量化都是一次性成本，放到检索路径会让每个槽位都付一次。
 *
 * ## 向量化失败不阻断入库
 *
 * 与 TP-2-14 的计划向量化同一处理：素材本身完全可用，只是语义项按中性
 * 0.5 计入（10.1）。反过来让它阻断，会因为嵌入服务抖动而丢掉一批已经
 * 处理好并上传完的素材 —— 而那批素材的对象已经在存储里了。
 */

export interface IngestAssetInput {
  readonly bytes: Uint8Array;
  /** 素材描述的实体（景点名 / 菜名）。Hero 类可为 null */
  readonly entityName: string | null;
  readonly destinationName: string | null;
  readonly destinationPlaceId: string | null;
  readonly title: string | null;
  readonly styleTags: readonly string[];
  readonly licenseType: LicenseType;
  readonly attributionText: string | null;
  readonly licenseExpiresAt: Date | null;
  readonly sourceType: AssetSourceType;
  readonly representationType: RepresentationType;
  /** 原始地址（二十章要求记录来源）。平台自有素材为 null */
  readonly originalUrl: string | null;
  /** 19.2 的缓存键。种子素材不带键（不参与键复用） */
  readonly cacheKey: string | null;
  /** AI 生成物必填（二十章、迁移 0005 的 CHECK） */
  readonly generationMetadata: unknown;
  /** 该素材面向的角色与比例，决定 11.2 的校验口径 */
  readonly role: AssetRole;
  readonly aspectRatio: AspectRatio;
  readonly minWidth: number;
}

export interface IngestDeps {
  readonly assets: AssetsRepository;
  readonly storage: ObjectStorage;
  readonly embedding: EmbeddingClient;
  readonly logger: Logger;
}

export type IngestResult =
  | { readonly kind: 'ingested'; readonly assetId: string; readonly created: boolean }
  | { readonly kind: 'rejected'; readonly rejection: ProcessImageRejection };

/**
 * 对象键。
 *
 * 形如 `assets/destination_photo/9f/9f8e....webp`。
 *
 *   - 按角色分目录，便于按类型统计与生命周期规则；
 *   - 插入两位十六进制的散列前缀 —— 单目录下百万级对象会让某些 S3
 *     兼容实现（含 MinIO 的文件系统后端）的列举变慢；
 *   - 键里含 UUID，因此内容不可变，可以长期强缓存（见 @tps/storage）。
 */
export function assetObjectKey(role: AssetRole, assetId: string, suffix: string): string {
  return `assets/${role.toLowerCase()}/${assetId.slice(0, 2)}/${assetId}${suffix}`;
}

export async function ingestAsset(
  deps: IngestDeps,
  input: IngestAssetInput,
): Promise<IngestResult> {
  const processed = await processImage(input.bytes, {
    aspectRatio: input.aspectRatio,
    minWidth: input.minWidth,
  });

  if (processed.kind === 'rejected') {
    deps.logger.warn(
      { role: input.role, reason: processed.rejection.reason },
      '素材未通过 11.2 后处理校验，已拒绝入库',
    );
    return { kind: 'rejected', rejection: processed.rejection };
  }

  const image = processed.image;
  /*
   * 素材 ID 在这里生成而不是用数据库默认值：对象键要含它，
   * 而对象必须在写库**之前**上传完成 —— 先写库会让「库里有行、对象不存在」
   * 成为可能，那种行会被检索命中，页面上是裂图。
   * 反过来（对象已上传但库里没有）只是浪费一点存储，可由清理任务处理。
   */
  const assetId = randomUUID();
  const originalKey = assetObjectKey(input.role, assetId, '.webp');
  const thumbnailKey = assetObjectKey(input.role, assetId, '-thumb.webp');

  const storageUrl = await deps.storage.put({
    key: originalKey,
    body: image.webp,
    contentType: 'image/webp',
  });
  const thumbnailUrl = await deps.storage.put({
    key: thumbnailKey,
    body: image.thumbnail,
    contentType: 'image/webp',
  });

  const searchText = buildSearchText({
    entityName: input.entityName,
    destinationName: input.destinationName,
    title: input.title,
    styleTags: input.styleTags,
  });

  let embedding: number[] | null = null;
  try {
    const [vector] = await deps.embedding.embed([
      semanticQueryText({
        role: input.role,
        entityName: input.entityName,
        destination: input.destinationName,
        styleTags: input.styleTags,
      }),
    ]);
    embedding = vector ?? null;
  } catch (error) {
    deps.logger.warn(
      { role: input.role },
      `素材向量化失败，该素材的语义项将按中性值计入：${String(error)}`,
    );
  }

  const saved = await deps.assets.insertAsset({
    assetId,
    assetType: 'IMAGE',
    sourceType: input.sourceType,
    representationType: input.representationType,
    entityName: input.entityName,
    destinationName: input.destinationName,
    destinationPlaceId: input.destinationPlaceId,
    title: input.title,
    originalUrl: input.originalUrl,
    storageUrl,
    thumbnailUrl,
    mimeType: 'image/webp',
    width: image.width,
    height: image.height,
    aspectRatio: image.aspectRatio,
    styleTags: input.styleTags,
    searchText,
    licenseType: input.licenseType,
    attributionText: input.attributionText,
    licenseExpiresAt: input.licenseExpiresAt,
    qualityScore: image.quality.score,
    embedding,
    cacheKey: input.cacheKey,
    generationMetadata: input.generationMetadata,
  });

  if (!saved.created) {
    /*
     * 同 `cache_key` 已存在：并发生成时的第二个进程走到这里（13.8 的锁是
     * 第一道防线，`assets_cache_key_uk` 是最后一道）。
     *
     * 此时**不写变体**：库里那行指向的是先到者的对象，
     * 把本次上传的缩略图挂过去会让 `assets.thumbnail_url` 与
     * `asset_variants.storage_url` 指向两份不同的文件 ——
     * 内容一样，但从此无法判断哪个是有效的。
     * 本次上传的两个对象成为孤儿，由存储生命周期规则回收。
     */
    deps.logger.info(
      { role: input.role },
      '同缓存键素材已存在，复用既有素材（本次上传的对象将由生命周期规则回收）',
    );
    return { kind: 'ingested', assetId: saved.assetId, created: false };
  }

  /*
   * 缩略图同时登记为变体：`assets.thumbnail_url` 是展示用的快路径，
   * `asset_variants` 是变体的完整台账（11.2 第 5 步，将来会有多档宽度）。
   * 两处都写是有意的冗余 —— 少了前者每次展示都要 join，
   * 少了后者就无法回答「这张图有哪些衍生物」。
   */
  await deps.assets.insertVariant({
    assetId: saved.assetId,
    variantType: 'THUMBNAIL',
    width: image.thumbnailWidth,
    height: image.thumbnailHeight,
    mimeType: 'image/webp',
    storageUrl: thumbnailUrl,
  });

  return { kind: 'ingested', assetId: saved.assetId, created: true };
}
