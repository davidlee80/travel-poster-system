import { createAssetsRepository, createPool, migrate, migrationsDirectory } from '@tps/db';
import { LocalHashingEmbeddingClient } from '@tps/llm';
import { InMemoryObjectStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assetObjectKey, ingestAsset, type IngestAssetInput } from './ingest.js';
import { PLACEHOLDER_SPECS, renderPlaceholder } from './placeholders.js';
import { parseSeedManifest } from './seed-manifest.js';

/**
 * 素材入库管道（TP-3-06、TP-3-11，需真实 PostgreSQL）。
 *
 * 对象存储用进程内实现：`S3ObjectStorage` 的写入由
 * `@tps/storage` 的集成测试覆盖（需 MinIO）。这里要验证的是
 * **管道**——后处理、search_text、向量、两张表的写入，
 * 而那些都不依赖真实 S3。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

/** 生成一张可通过 11.2 校验的图（有高频细节，比例匹配） */
async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 7;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    pixels[i] = state % 256;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

describeIntegration('素材入库管道（集成，需 PostgreSQL）', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 20_000,
    });
    await migrate(pool, migrationsDirectory());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });

  function deps() {
    return {
      assets: createAssetsRepository(pool),
      storage: new InMemoryObjectStorage(),
      embedding: new LocalHashingEmbeddingClient(),
      logger: createSilentLogger(),
    };
  }

  async function input(overrides: Partial<IngestAssetInput> = {}): Promise<IngestAssetInput> {
    return {
      bytes: await photo(1200, 675),
      entityName: '拱宸桥',
      destinationName: '杭州',
      destinationPlaceId: 'cn-hangzhou',
      title: '拱宸桥晨景',
      styleTags: ['bridge', 'canal'],
      licenseType: 'CC0',
      attributionText: null,
      licenseExpiresAt: null,
      sourceType: 'PLATFORM_LIBRARY',
      representationType: 'PHOTOGRAPHIC',
      originalUrl: 'https://example.com/original.jpg',
      cacheKey: null,
      generationMetadata: null,
      role: 'DESTINATION_PHOTO',
      aspectRatio: '16:9',
      minWidth: 800,
      ...overrides,
    };
  }

  it('入库后 assets 与 asset_variants 各一行，字段完整', async () => {
    const d = deps();
    const result = await ingestAsset(d, await input());

    expect(result.kind).toBe('ingested');
    if (result.kind !== 'ingested') return;

    const { rows } = await pool.query<{
      storage_url: string;
      thumbnail_url: string;
      mime_type: string;
      width: number;
      height: number;
      aspect_ratio: string;
      quality_score: string;
      search_text: string;
      has_embedding: boolean;
      original_url: string;
      style_tags: unknown;
      license_type: string;
    }>(
      `SELECT storage_url, thumbnail_url, mime_type, width, height, aspect_ratio,
              quality_score, search_text, embedding IS NOT NULL AS has_embedding,
              original_url, style_tags, license_type
         FROM assets WHERE id = $1`,
      [result.assetId],
    );

    const row = rows[0]!;
    expect(row.mime_type).toBe('image/webp');
    expect(row.width).toBe(1200);
    expect(row.height).toBe(675);
    expect(Number(row.aspect_ratio)).toBeCloseTo(16 / 9, 4);
    expect(row.has_embedding).toBe(true);
    expect(row.license_type).toBe('CC0');
    // 二十章：外部图片必须记录来源
    expect(row.original_url).toBe('https://example.com/original.jpg');
    expect(row.style_tags).toEqual(['bridge', 'canal']);

    // 10.1：quality_score 入库时算好，检索路径不实时算
    expect(Number(row.quality_score)).toBeGreaterThan(0);
    expect(Number(row.quality_score)).toBeLessThanOrEqual(1);

    // search_text 含原文与二元组（GIN 侧的 simple 分词器不认中文整串）
    expect(row.search_text).toContain('拱宸桥');
    expect(row.search_text).toContain('拱宸');

    const variants = await pool.query<{ variant_type: string; width: number }>(
      'SELECT variant_type, width FROM asset_variants WHERE asset_id = $1',
      [result.assetId],
    );
    expect(variants.rows).toHaveLength(1);
    expect(variants.rows[0]).toMatchObject({ variant_type: 'THUMBNAIL', width: 640 });

    // 对象键按角色分目录并带散列前缀
    expect([...d.storage.objects.keys()]).toEqual([
      assetObjectKey('DESTINATION_PHOTO', result.assetId, '.webp'),
      assetObjectKey('DESTINATION_PHOTO', result.assetId, '-thumb.webp'),
    ]);
  });

  it('上传的确实是 WebP，且缩略图更小', async () => {
    const d = deps();
    const result = await ingestAsset(d, await input());
    if (result.kind !== 'ingested') throw new Error('应当入库');

    const objects = [...d.storage.objects.values()];
    expect(objects).toHaveLength(2);
    for (const object of objects) {
      expect(object.contentType).toBe('image/webp');
      expect((await sharp(object.body).metadata()).format).toBe('webp');
    }
    expect(objects[1]!.body.byteLength).toBeLessThan(objects[0]!.body.byteLength);
  });

  it('11.2 校验不通过时不落库、不上传', async () => {
    const d = deps();
    const result = await ingestAsset(d, await input({ bytes: await photo(400, 225) }));

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.reason).toBe('RESOLUTION_TOO_LOW');

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
    expect(rows[0]!.count).toBe('0');
    // 被拒的素材不该在存储里留下垃圾
    expect(d.storage.objects.size).toBe(0);
  });

  it('同 cache_key 重复灌入复用既有素材，不写第二行变体', async () => {
    const d = deps();
    const cacheKey = 'placeholder:v1:destination_photo:16x9';

    const first = await ingestAsset(d, await input({ cacheKey }));
    const second = await ingestAsset(d, await input({ cacheKey }));

    if (first.kind !== 'ingested' || second.kind !== 'ingested') throw new Error('应当入库');
    expect(second.assetId).toBe(first.assetId);
    expect(second.created).toBe(false);

    const assets = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
    expect(assets.rows[0]!.count).toBe('1');
    const variants = await pool.query<{ count: string }>('SELECT count(*) FROM asset_variants');
    expect(variants.rows[0]!.count).toBe('1');

    /*
     * 第二次上传的两个对象（原图 + 缩略图）已被当场删掉，因此桶里只剩
     * 先到者的两个（R-83）。
     *
     * 这一行断言的是一个**以前不存在的机制**：原先注释说孤儿对象「由存储
     * 生命周期规则回收」，而素材桶从未配过任何规则 —— 于是它们永久累积。
     * 没有这条断言，下一个把 `delete` 改成日志一行就算的人不会被拦住。
     */
    expect(d.storage.objects.size).toBe(2);
  });

  it('灌入后可被 findCandidates 检索到（管道到检索是通的）', async () => {
    const d = deps();
    const result = await ingestAsset(d, await input());
    if (result.kind !== 'ingested') throw new Error('应当入库');

    const [vector] = await d.embedding.embed(['拱宸桥 杭州 景点照片 bridge canal']);
    const candidates = await d.assets.findCandidates({
      embedding: vector!,
      assetType: 'IMAGE',
      entityName: '拱宸桥',
      destinationPlaceId: 'cn-hangzhou',
      limit: 30,
    });

    expect(candidates.map((c) => c.assetId)).toEqual([result.assetId]);
    // 余弦有值 —— 入库时向量化过
    expect(candidates[0]!.cosine).not.toBeNull();
  });

  it('三张默认占位图可灌入且标记为 DEFAULT_PLACEHOLDER + ILLUSTRATIVE', async () => {
    const d = deps();

    for (const spec of PLACEHOLDER_SPECS) {
      const bytes = await renderPlaceholder(spec);
      const result = await ingestAsset(d, {
        ...(await input()),
        bytes,
        entityName: null,
        destinationName: null,
        destinationPlaceId: null,
        title: spec.label,
        styleTags: ['placeholder'],
        licenseType: 'PLATFORM_OWNED',
        sourceType: 'DEFAULT_PLACEHOLDER',
        representationType: 'ILLUSTRATIVE',
        originalUrl: null,
        cacheKey: spec.cacheKey,
        role: spec.role,
        aspectRatio: spec.aspectRatio,
        minWidth: spec.minWidth,
      });

      expect(result.kind).toBe('ingested');
    }

    const { rows } = await pool.query<{
      count: string;
      illustrative: string;
    }>(
      `SELECT count(*) AS count,
              count(*) FILTER (WHERE representation_type = 'ILLUSTRATIVE') AS illustrative
         FROM assets WHERE source_type = 'DEFAULT_PLACEHOLDER'`,
    );
    expect(rows[0]!.count).toBe('3');
    // 占位图不是照片 —— 与 9.4 对 AI 图的同一条原则
    expect(rows[0]!.illustrative).toBe('3');

    /*
     * 占位图不会在 LOCAL_LIBRARY_MATCH 里冒出来 —— 但**不是**因为
     * quality_score 低（实测渐变图能到 0.6 左右：清晰度接近 0，
     * 但曝光居中、边缘能量集中在中间的文字上）。
     *
     * 真正的机制是它们没有实体与目的地：entity_match 归零（权重 0.35）
     * 让景点/美食槽位的 final 上限约 0.5；Hero 虽按中性 0.5 计入实体项，
     * 但 destination_match 仍为 0，上限约 0.6。两者都低于 0.65 阈值。
     *
     * 这里直接断言这条机制，而不是断言一个会随渐变配色变化的分数。
     */
    const candidates = await d.assets.findCandidates({
      embedding: null,
      assetType: 'IMAGE',
      // 占位图的 entity_name 与 destination 都是 null，因此三个预过滤维度
      // 都命中不到它们 —— 连候选集都进不去
      entityName: '拱宸桥',
      destinationPlaceId: 'cn-hangzhou',
      destinationName: '杭州',
      limit: 30,
    });
    expect(candidates).toHaveLength(0);
  });

  it('清单解析：错行整体拒绝而不是跳过', () => {
    const manifest = [
      '{"file":"a.jpg","role":"DESTINATION_PHOTO","entity_name":"拱宸桥","license_type":"CC0"}',
      '{"file":"b.jpg","role":"ROUTE_MAP","license_type":"CC0"}',
      '{"file":"c.jpg","role":"FOOD_IMAGE"}',
      'not json',
    ].join('\n');

    const { entries, errors } = parseSeedManifest(manifest);
    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });
});
