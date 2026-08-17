import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { migrationsDirectory } from './migrations-dir.js';
import { createAssetsRepository, type AssetsRepository, type InsertAssetInput } from './assets.js';

/**
 * 素材库仓储（TP-3-09、TP-3-13，需真实 PostgreSQL + pgvector）。
 *
 * 这里验证的是 **SQL 本身**：三个必须出现的谓词（在架、授权未到期、
 * 精确键）、OR 形式的预过滤、向量排序与未向量化行的位置。
 * 这些都无法用假仓储替代 —— 假仓储只会重复我对 SQL 的理解。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

/** 1536 维单位向量：第 index 位为 1，其余为 0（余弦可手算） */
function unitVector(index: number): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[index] = 1;
  return vector;
}

describeIntegration('素材库仓储（集成，需 PostgreSQL）', () => {
  let pool: Pool;
  let repo: AssetsRepository;

  beforeAll(async () => {
    pool = createPool({
      connectionString: databaseUrl as string,
      maxConnections: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    });
    await migrate(pool, migrationsDirectory());
    repo = createAssetsRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM plan_asset_bindings');
    await pool.query('DELETE FROM assets');
  });

  function input(overrides: Partial<InsertAssetInput> = {}): InsertAssetInput {
    return {
      assetType: 'IMAGE',
      sourceType: 'PLATFORM_LIBRARY',
      representationType: 'PHOTOGRAPHIC',
      entityName: '拱宸桥',
      destinationName: '杭州',
      destinationPlaceId: 'cn-hangzhou',
      title: '拱宸桥晨景',
      originalUrl: null,
      storageUrl: 's3://tps-assets/gongchen.webp',
      thumbnailUrl: 's3://tps-assets/gongchen-thumb.webp',
      mimeType: 'image/webp',
      width: 1600,
      height: 900,
      aspectRatio: 1.7778,
      styleTags: ['bridge', 'canal'],
      searchText: '拱宸 宸桥 杭州',
      licenseType: 'PLATFORM_OWNED',
      attributionText: null,
      licenseExpiresAt: null,
      qualityScore: 0.86,
      embedding: unitVector(0),
      cacheKey: null,
      generationMetadata: null,
      ...overrides,
    };
  }

  describe('入库', () => {
    it('返回 created: true 并可被检索到', async () => {
      const { assetId, created } = await repo.insertAsset(input());
      expect(created).toBe(true);

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows.map((r) => r.assetId)).toEqual([assetId]);
      // NUMERIC 列转成数值而不是字符串
      expect(rows[0]!.qualityScore).toBeCloseTo(0.86, 4);
      expect(rows[0]!.aspectRatio).toBeCloseTo(1.7778, 4);
      expect(rows[0]!.styleTags).toEqual(['bridge', 'canal']);
    });

    it('同 cache_key 第二次入库返回既有素材而不是抛错（13.8 的最后一道防线）', async () => {
      const cacheKey = 'place:v1:hz-gongchen-bridge:destination_photo:16x9';
      const first = await repo.insertAsset(input({ cacheKey }));
      const second = await repo.insertAsset(input({ cacheKey, storageUrl: 's3://other.webp' }));

      expect(second.created).toBe(false);
      expect(second.assetId).toBe(first.assetId);

      const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
      expect(rows[0]!.count).toBe('1');
    });

    it('变体走 upsert，同素材同类型只一行', async () => {
      const { assetId } = await repo.insertAsset(input());
      await repo.insertVariant({
        assetId,
        variantType: 'THUMBNAIL',
        width: 320,
        height: 180,
        mimeType: 'image/webp',
        storageUrl: 's3://tps-assets/thumb-1.webp',
      });
      await repo.insertVariant({
        assetId,
        variantType: 'THUMBNAIL',
        width: 400,
        height: 225,
        mimeType: 'image/webp',
        storageUrl: 's3://tps-assets/thumb-2.webp',
      });

      const { rows } = await pool.query<{ storage_url: string; width: number }>(
        'SELECT storage_url, width FROM asset_variants WHERE asset_id = $1',
        [assetId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ storage_url: 's3://tps-assets/thumb-2.webp', width: 400 });
    });
  });

  describe('检索谓词', () => {
    it('下架素材不出现在候选里（19.3 的人工下架）', async () => {
      const { assetId } = await repo.insertAsset(input());
      await pool.query(`UPDATE assets SET status = 'RETIRED' WHERE id = $1`, [assetId]);

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows).toHaveLength(0);
    });

    it('授权已到期的素材不出现在候选里（19.3 的授权到期）', async () => {
      await repo.insertAsset(
        input({
          licenseType: 'LICENSED',
          attributionText: '© 某图库',
          licenseExpiresAt: new Date('2020-01-01T00:00:00Z'),
        }),
      );

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows).toHaveLength(0);
    });

    it('未到期的授权素材正常返回', async () => {
      await repo.insertAsset(
        input({
          licenseType: 'LICENSED',
          attributionText: '© 某图库',
          licenseExpiresAt: new Date('2099-01-01T00:00:00Z'),
        }),
      );

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attributionText).toBe('© 某图库');
    });

    it('预过滤是 OR：同城但实体名不同的素材仍是候选', async () => {
      /*
       * 取交集会让 Hero（根本没有实体名）与美食图的主要来源全部落选。
       * 交集应当由**评分**表达（entity 0.35 + destination 0.20），
       * 而不是由过滤表达 —— 过滤是二元的，切掉就没有挽回机会。
       */
      await repo.insertAsset(input({ entityName: '灵隐寺' }));

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        destinationPlaceId: 'cn-hangzhou',
        limit: 30,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entityName).toBe('灵隐寺');
    });

    it('三个预过滤维度都为空时不返回任何候选（避免全表扫描）', async () => {
      await repo.insertAsset(input());
      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        limit: 30,
      });
      expect(rows).toHaveLength(0);
    });

    it('asset_type 隔离：SVG 不会出现在图片检索里', async () => {
      await repo.insertAsset(input({ assetType: 'SVG', mimeType: 'image/svg+xml' }));
      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe('向量排序与余弦换算', () => {
    it('余弦是 1 - 距离，正交向量得 0', async () => {
      await repo.insertAsset(input({ embedding: unitVector(0) }));
      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(rows[0]!.cosine).toBeCloseTo(1, 5);

      const orthogonal = await repo.findCandidates({
        embedding: unitVector(5),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });
      expect(orthogonal[0]!.cosine).toBeCloseTo(0, 5);
    });

    it('按距离升序返回，未向量化的行排最后', async () => {
      const near = await repo.insertAsset(input({ embedding: unitVector(0) }));
      const far = await repo.insertAsset(
        input({ embedding: unitVector(7), storageUrl: 's3://far.webp' }),
      );
      const none = await repo.insertAsset(
        input({ embedding: null, storageUrl: 's3://none.webp', qualityScore: 0.99 }),
      );

      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });

      expect(rows.map((r) => r.assetId)).toEqual([near.assetId, far.assetId, none.assetId]);
      expect(rows[2]!.cosine).toBeNull();
    });

    it('查询向量为 null 时按质量分降序（向量化失败的降级路径）', async () => {
      const low = await repo.insertAsset(input({ qualityScore: 0.3 }));
      const high = await repo.insertAsset(
        input({ qualityScore: 0.95, storageUrl: 's3://high.webp' }),
      );

      const rows = await repo.findCandidates({
        embedding: null,
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 30,
      });

      expect(rows.map((r) => r.assetId)).toEqual([high.assetId, low.assetId]);
      // 无查询向量时余弦无意义，必须是 null 而不是 0（0 会被当成「正交」计分）
      expect(rows.every((r) => r.cosine === null)).toBe(true);
    });

    it('limit 生效（10.2 的 Top 30）', async () => {
      for (let i = 0; i < 5; i += 1) {
        await repo.insertAsset(input({ storageUrl: `s3://a-${i}.webp` }));
      }
      const rows = await repo.findCandidates({
        embedding: unitVector(0),
        assetType: 'IMAGE',
        entityName: '拱宸桥',
        limit: 3,
      });
      expect(rows).toHaveLength(3);
    });
  });

  describe('cache_key 命中（19.4）', () => {
    it('精确键命中返回素材', async () => {
      const cacheKey = 'hero:v1:cn-hangzhou:canal_culture:chinese_travel_editorial:16x6';
      const { assetId } = await repo.insertAsset(input({ cacheKey }));

      const found = await repo.findByCacheKey(cacheKey);
      expect(found?.assetId).toBe(assetId);
      // 命中路径不需要余弦 —— 19.4 明确不重算评分
      expect(found?.cosine).toBeNull();
    });

    it('键不存在返回 null', async () => {
      expect(await repo.findByCacheKey('hero:v1:nope:general:x:1x1')).toBeNull();
    });

    it('下架素材的键不再命中（否则下架等于没下架）', async () => {
      const cacheKey = 'place:v1:hz-gongchen-bridge:destination_photo:16x9';
      const { assetId } = await repo.insertAsset(input({ cacheKey }));
      await pool.query(`UPDATE assets SET status = 'RETIRED' WHERE id = $1`, [assetId]);

      expect(await repo.findByCacheKey(cacheKey)).toBeNull();
    });
  });
});
