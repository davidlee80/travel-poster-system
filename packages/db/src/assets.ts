import type { Pool } from 'pg';

/**
 * 素材库仓储（TP-3-09、TP-3-13、TP-3-06，设计稿 10.2、19.4、十五章）。
 *
 * ## 与 15.2 的检索隔离无关
 *
 * `travel_plan_versions` 的检索要走受限只读角色，因为那张表含**用户私有
 * 计划内容**。`assets` 不含任何用户数据（十五章「表关系总览」：全局共享），
 * 因此这里用普通连接。把两者混为一谈会让素材检索白白背上
 * `SET LOCAL ROLE` 的开销与列级授权的维护成本。
 *
 * ## 三个谓词在每个读方法里都必须出现
 *
 *   status = 'ACTIVE'                                  19.3 人工下架
 *   license_expires_at IS NULL OR > NOW()              19.3 授权到期
 *   （命中路径额外要求 cache_key 精确相等）              19.4
 *
 * 漏掉前两个的表现是「下架/过期素材继续出现在新计划里」——
 * 而页面看起来完全正常，只有法务会发现。
 */

/** 10.1 打分所需的字段 + 展示所需的字段 */
export interface AssetCandidateRow {
  readonly assetId: string;
  readonly entityName: string | null;
  readonly destinationName: string | null;
  readonly destinationPlaceId: string | null;
  readonly assetType: string;
  readonly sourceType: string;
  readonly representationType: string;
  readonly mimeType: string | null;
  readonly storageUrl: string;
  readonly thumbnailUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly aspectRatio: number | null;
  readonly qualityScore: number | null;
  readonly licenseType: string;
  readonly attributionText: string | null;
  readonly styleTags: readonly string[];
  /** 与查询向量的余弦值（`1 - 距离`）。素材未向量化时为 null */
  readonly cosine: number | null;
}

export interface FindCandidatesQuery {
  /** 查询向量。为 null 时退化为按质量分排序（见实现说明） */
  readonly embedding: readonly number[] | null;
  readonly assetType: string;
  /** 10.2 的 entity 预过滤。缺省（Hero）时只按目的地过滤 */
  readonly entityName?: string | null;
  readonly destinationPlaceId?: string | null;
  readonly destinationName?: string | null;
  /** 10.2 第 1 步：Top 30 */
  readonly limit: number;
}

export interface InsertAssetInput {
  /**
   * 素材 ID 由**调用方**生成，不用数据库默认值。
   *
   * 理由与 `savePlanVersion` 的 `versionId` 相同（见 travel-plans.ts）：
   * 对象存储的键里含素材 ID（`assets/{role}/{ab}/{id}.webp`），
   * 而对象必须在写库**之前**上传完成。让数据库生成的话，上传时还不知道 ID，
   * 只能先用一个临时 ID —— 于是键里的 ID 与行的 ID 永远对不上，
   * 「这个对象属于哪个素材」只能靠 `storage_url` 反查字符串。
   */
  readonly assetId: string;
  readonly assetType: string;
  readonly sourceType: string;
  readonly representationType: string;
  readonly entityName: string | null;
  readonly destinationName: string | null;
  readonly destinationPlaceId: string | null;
  readonly title: string | null;
  readonly originalUrl: string | null;
  readonly storageUrl: string;
  readonly thumbnailUrl: string | null;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly styleTags: readonly string[];
  readonly searchText: string;
  readonly licenseType: string;
  readonly attributionText: string | null;
  readonly licenseExpiresAt: Date | null;
  readonly qualityScore: number | null;
  readonly embedding: readonly number[] | null;
  readonly cacheKey: string | null;
  readonly generationMetadata: unknown;
  /**
   * 原图字节的 SHA-256（R-47，迁移 0007）。
   *
   * 只有 9.6 的搜索入库会带它 —— 平台自有素材与 AI 生成物省略即写 `NULL`，
   * 不参与指纹去重（理由见迁移 0007 的头部注释）。
   */
  readonly contentHash?: string;
}

/**
 * 指纹查询的返回形态（TP-6-05）。
 *
 * 刻意**不复用** `AssetCandidateRow`：那个类型是给评分用的，带着宽高、
 * 余弦、授权文本等十几个列，而合并分支只需要「是哪一行、能不能用、
 * 现有标签是什么」。返回大对象会让调用方看不出这条路径实际依赖哪几个字段。
 */
export interface AssetFingerprintRow {
  readonly assetId: string;
  /** `ACTIVE` / `RETIRED`（R-30）。下架行也会被返回，见 `findByContentHash` */
  readonly status: string;
  readonly styleTags: readonly string[];
  readonly searchText: string | null;
}

export interface MergeTagsInput {
  readonly assetId: string;
  readonly styleTags: readonly string[];
  readonly searchText: string;
}

export interface InsertVariantInput {
  readonly assetId: string;
  readonly variantType: 'ORIGINAL' | 'THUMBNAIL';
  readonly width: number | null;
  readonly height: number | null;
  readonly mimeType: string;
  readonly storageUrl: string;
}

export interface AssetsRepository {
  /** 10.2 第 1 步 */
  findCandidates(query: FindCandidatesQuery): Promise<readonly AssetCandidateRow[]>;
  /** 19.4：精确键命中，不重算评分 */
  findByCacheKey(cacheKey: string): Promise<AssetCandidateRow | null>;
  /**
   * 按内容指纹查已有素材（R-47 的去重分支入口）。
   *
   * **不过滤 `status`**，与 `findByCacheKey` 相反。它回答的不是「找一张能用的
   * 图」而是「这份字节在库里存在吗」—— 存在就不能再插（`assets_content_hash_uk`）。
   * 过滤掉下架行会让一张被人工下架的图在下次搜索命中时试图重新入库，
   * 撞唯一索引后该候选被判为失败；而正确行为是识别出它已下架、换下一个候选。
   */
  findByContentHash(contentHash: string): Promise<AssetFingerprintRow | null>;
  /**
   * 标签并集合并（R-47）：同一张图从第二个上下文再次被搜到时，
   * 把新上下文的风格标签与检索词并进已有行，而不是新增一行。
   *
   * 只动 `style_tags` 与 `search_text` 两列 —— 其余列描述的是**那一份字节**
   * （尺寸、质量分、授权、对象键），与它被哪些词命中无关。
   */
  mergeTags(input: MergeTagsInput): Promise<void>;
  /**
   * 入库。同 `cache_key` 已存在时返回既有素材而不是抛错 ——
   * 13.8 的 `lock:asset:{cache_key}` 是第一道防线，这里是最后一道
   * （两个进程同时生成同一张图时，第二个应当复用而不是失败）。
   */
  insertAsset(input: InsertAssetInput): Promise<{ assetId: string; created: boolean }>;
  insertVariant(input: InsertVariantInput): Promise<void>;
}

/** `[0.1, 0.2]` → `'[0.1,0.2]'`（pgvector 的文本输入格式） */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

const CANDIDATE_COLUMNS = `
  a.id, a.entity_name, a.destination_name, a.destination_place_id,
  a.asset_type, a.source_type, a.representation_type, a.mime_type,
  a.storage_url, a.thumbnail_url, a.width, a.height, a.aspect_ratio,
  a.quality_score, a.license_type, a.attribution_text, a.style_tags`;

interface CandidateSqlRow {
  id: string;
  entity_name: string | null;
  destination_name: string | null;
  destination_place_id: string | null;
  asset_type: string;
  source_type: string;
  representation_type: string;
  mime_type: string | null;
  storage_url: string;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  quality_score: string | null;
  license_type: string;
  attribution_text: string | null;
  style_tags: unknown;
  cosine: number | null;
}

function toCandidate(row: CandidateSqlRow): AssetCandidateRow {
  return {
    assetId: row.id,
    entityName: row.entity_name,
    destinationName: row.destination_name,
    destinationPlaceId: row.destination_place_id,
    assetType: row.asset_type,
    sourceType: row.source_type,
    representationType: row.representation_type,
    mimeType: row.mime_type,
    storageUrl: row.storage_url,
    thumbnailUrl: row.thumbnail_url,
    width: row.width,
    height: row.height,
    // NUMERIC 经 pg 驱动是字符串
    aspectRatio: row.aspect_ratio === null ? null : Number(row.aspect_ratio),
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    licenseType: row.license_type,
    attributionText: row.attribution_text,
    styleTags: Array.isArray(row.style_tags) ? (row.style_tags as string[]) : [],
    cosine: row.cosine === null ? null : Number(row.cosine),
  };
}

export function createAssetsRepository(pool: Pool): AssetsRepository {
  return {
    async findCandidates(query) {
      const vector = query.embedding === null ? null : toVectorLiteral(query.embedding);

      /*
       * 预过滤是 OR 而不是 AND：10.2 说「带 entity/destination 预过滤」，
       * 而两者取交集会让「同城但实体名不同」的素材全部落选 ——
       * 那类素材正是 Hero 与美食图的主要来源（Hero 根本没有实体名）。
       * 交集应当由**评分**表达（entity 0.35 + destination 0.20 两项），
       * 而不是由过滤表达：过滤是二元的，一刀切掉就没有挽回机会。
       */
      const { rows } = await pool.query<CandidateSqlRow>(
        `SELECT ${CANDIDATE_COLUMNS},
                CASE WHEN a.embedding IS NULL OR $1::vector IS NULL THEN NULL
                     ELSE 1 - (a.embedding <=> $1::vector)
                END AS cosine
           FROM assets a
          WHERE a.status = 'ACTIVE'
            AND (a.license_expires_at IS NULL OR a.license_expires_at > NOW())
            AND a.asset_type = $2
            AND (
              ($3::text IS NOT NULL AND a.entity_name = $3::text)
              OR ($4::text IS NOT NULL AND a.destination_place_id = $4::text)
              OR ($5::text IS NOT NULL AND a.destination_name = $5::text)
            )
          ORDER BY CASE WHEN $1::vector IS NULL THEN NULL
                        ELSE a.embedding <=> $1::vector
                   END ASC NULLS LAST,
                   a.quality_score DESC NULLS LAST,
                   a.created_at DESC
          LIMIT $6`,
        [
          vector,
          query.assetType,
          query.entityName ?? null,
          query.destinationPlaceId ?? null,
          query.destinationName ?? null,
          query.limit,
        ],
      );

      return rows.map(toCandidate);
    },

    async findByCacheKey(cacheKey) {
      const { rows } = await pool.query<CandidateSqlRow>(
        `SELECT ${CANDIDATE_COLUMNS}, NULL::float8 AS cosine
           FROM assets a
          WHERE a.cache_key = $1
            AND a.status = 'ACTIVE'
            AND (a.license_expires_at IS NULL OR a.license_expires_at > NOW())`,
        [cacheKey],
      );

      const row = rows[0];
      return row === undefined ? null : toCandidate(row);
    },

    async findByContentHash(contentHash) {
      const { rows } = await pool.query<{
        id: string;
        status: string;
        style_tags: string[];
        search_text: string | null;
      }>(
        // 无 status 谓词是有意的，见接口上的说明
        `SELECT id, status, style_tags, search_text
           FROM assets
          WHERE content_hash = $1`,
        [contentHash],
      );

      const row = rows[0];
      return row === undefined
        ? null
        : {
            assetId: row.id,
            status: row.status,
            styleTags: row.style_tags,
            searchText: row.search_text,
          };
    },

    async mergeTags(input) {
      /*
       * 并集在 SQL 里做而不是「读出来、在 TypeScript 里合、写回去」：
       * 后者是读-改-写，两个槽位同时命中同一份字节时会互相覆盖对方的标签
       * （14 天任务里这不是理论情况 —— 同城多天很容易搜到同一张图）。
       *
       * 两列都归一为**字典序**：合并结果因此与调用次序无关，
       * 否则同一批标签按不同顺序合进来会得到不同的行，diff 与断言都不稳定。
       * 顺序对两列的用途都无影响（`style_tags` 参与评分是按集合，
       * `search_text` 进的是 `to_tsvector`）。
       */
      await pool.query(
        `UPDATE assets
            SET style_tags = COALESCE((
                  SELECT jsonb_agg(DISTINCT tag ORDER BY tag)
                    FROM jsonb_array_elements_text(style_tags || $2::jsonb) AS tag
                   WHERE tag <> ''
                ), '[]'::jsonb),
                search_text = (
                  SELECT string_agg(DISTINCT word, ' ' ORDER BY word)
                    FROM unnest(
                           string_to_array(
                             trim(COALESCE(search_text, '') || ' ' || $3), ' ')) AS word
                   WHERE word <> ''
                )
          WHERE id = $1`,
        [input.assetId, JSON.stringify(input.styleTags), input.searchText],
      );
    },

    async insertAsset(input) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (
           id, asset_type, source_type, representation_type, entity_name, destination_name,
           destination_place_id, title, original_url, storage_url, thumbnail_url,
           mime_type, width, height, aspect_ratio, style_tags, search_text,
           license_type, attribution_text, license_expires_at, quality_score,
           embedding, cache_key, generation_metadata, content_hash)
         VALUES ($24::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15::jsonb, $16, $17, $18, $19, $20, $21::vector, $22, $23::jsonb, $25)
         ON CONFLICT (cache_key) WHERE cache_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          input.assetType,
          input.sourceType,
          input.representationType,
          input.entityName,
          input.destinationName,
          input.destinationPlaceId,
          input.title,
          input.originalUrl,
          input.storageUrl,
          input.thumbnailUrl,
          input.mimeType,
          input.width,
          input.height,
          input.aspectRatio,
          JSON.stringify(input.styleTags),
          input.searchText,
          input.licenseType,
          input.attributionText,
          input.licenseExpiresAt,
          input.qualityScore,
          input.embedding === null ? null : toVectorLiteral(input.embedding),
          input.cacheKey,
          input.generationMetadata === null ? null : JSON.stringify(input.generationMetadata),
          input.assetId,
          input.contentHash ?? null,
        ],
      );

      const inserted = rows[0];
      if (inserted !== undefined) return { assetId: inserted.id, created: true };

      /*
       * DO NOTHING 命中：同键素材已存在。读回它的 ID 让调用方能继续绑定 ——
       * 抛错的话，「两个进程同时为同一个键生成」会有一个任务失败，
       * 而它本该直接复用对方的产物。
       */
      const existing = await pool.query<{ id: string }>(
        'SELECT id FROM assets WHERE cache_key = $1',
        [input.cacheKey],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(`素材入库未插入且按 cache_key 查不到：${String(input.cacheKey)}`);
      }
      return { assetId: row.id, created: false };
    },

    async insertVariant(input) {
      await pool.query(
        `INSERT INTO asset_variants (asset_id, variant_type, width, height, mime_type, storage_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (asset_id, variant_type)
         DO UPDATE SET storage_url = EXCLUDED.storage_url,
                       width = EXCLUDED.width,
                       height = EXCLUDED.height,
                       mime_type = EXCLUDED.mime_type`,
        [
          input.assetId,
          input.variantType,
          input.width,
          input.height,
          input.mimeType,
          input.storageUrl,
        ],
      );
    },
  };
}
