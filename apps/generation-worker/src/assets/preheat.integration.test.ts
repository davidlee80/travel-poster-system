import { createAssetsRepository, createPool, migrate, migrationsDirectory } from '@tps/db';
import { FakeImageClient, LocalHashingEmbeddingClient } from '@tps/llm';
import { InMemoryObjectStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { renderFakeGeneratedImage } from './fake-image.js';
import { generateAiAsset } from './generate-asset.js';
import { ingestAsset, type IngestAssetInput } from './ingest.js';
import { BUCKET_THEME_PHRASE, parsePreheatManifest, preheatTargets } from './preheat.js';
import { cacheKeyFor } from './resolve-assets.js';
import { ROLE_INGEST_DEFAULTS, parseSeedManifest, type SeedManifestEntry } from './seed-manifest.js';

/**
 * 预热两条轨道的端到端（集成，需 PostgreSQL）。
 *
 * ## fake 模式下能测什么、不能测什么
 *
 * **能测**：清单解析 → 键计算 → 落库 → 复用 → 运行时按键命中。这条链上除了
 * 「图好不好看」之外的每一步都与生产一致 —— `FakeImageClient` 产出的是真实的
 * 图片字节，会走同一套 sharp 后处理、同一套 11.2 校验、同一套 assets 写入。
 *
 * **不能测**：画面内容。`preheat-cli.ts` 因此在 fake 模式下打警告而不是拒绝 ——
 * 链路值得验，产物不能当预热成果。这个测试正是那句「fake 预热仍然有用」的落点。
 *
 * ## 为什么必须有这一层
 *
 * 单元测试各自验了片段：`preheat.test.ts` 验清单与目标枚举，
 * `generate-asset.test.ts` 从 `preheatTargets(...)[0].request` 起步验生成与复用，
 * `preheat-parity.test.ts` 验键与运行时一致。但没有一处把它们串起来 ——
 * 而 19.5 的承诺（「上线前灌入，让绝大多数请求走缓存命中」）是链条级的：
 * 任一环断了，表现都是「命中率为 0 而看不出原因」。
 */

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl === undefined ? describe.skip : describe;

/** 一张确定性的假照片。用 sharp 造真实字节，因为 11.2 的校验会解码它 */
async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 7;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    pixels[i] = state % 256;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

/**
 * 把一条清单条目变成 `ingestAsset` 的入参，与 `ingest-cli.ts` 的 manifest 分支同形。
 *
 * 写成模块级函数而不是各个 describe 里各写一份：两份副本漂移了也不会报错，
 * 而它们模拟的正是「CLI 怎么调」—— 那一处必须只有一份口径。
 */
function ingestInputFor(entry: SeedManifestEntry, bytes: Uint8Array): IngestAssetInput {
  const defaults = ROLE_INGEST_DEFAULTS[entry.role];
  return {
    bytes,
    entityName: entry.entity_name,
    destinationName: entry.destination_name,
    destinationPlaceId: entry.destination_place_id,
    title: entry.title,
    styleTags: entry.style_tags,
    licenseType: entry.license_type,
    attributionText: entry.attribution_text,
    licenseExpiresAt: null,
    sourceType: entry.source_type,
    representationType: entry.representation_type,
    originalUrl: entry.original_url,
    // 种子素材不带缓存键（ingest-cli.ts L185-187）
    cacheKey: null,
    generationMetadata: null,
    role: entry.role,
    aspectRatio: entry.aspect_ratio ?? defaults.aspectRatio,
    minWidth: entry.min_width ?? defaults.minWidth,
  };
}

/** 运行时形态的 Hero 需求项，用于按 `cacheKeyFor` 反查预热产物 */
function heroRequirement(
  destination: { readonly place_id: string; readonly name: string },
  theme: string,
): Parameters<typeof cacheKeyFor>[0] {
  return {
    slot_id: 'day_1.hero_background',
    role: 'HERO_BACKGROUND',
    required: true,
    subject: {
      destination: destination.name,
      destination_place_id: destination.place_id,
      theme,
    },
    visual_constraints: { aspect_ratio: '16:6', min_width: 1600 },
  } as Parameters<typeof cacheKeyFor>[0];
}

describeIntegration('预热两条轨道端到端（集成，需 PostgreSQL）', () => {
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
      image: new FakeImageClient(renderFakeGeneratedImage),
      imageTimeoutMs: 5_000,
    };
  }

  describe('轨道 A：从清单到「运行时按键命中」', () => {
    const MANIFEST = [
      '# 本地打通链路用',
      '{ "place_id": "cn_hangzhou", "name": "杭州" }',
      '{ "place_id": "cn_suzhou", "name": "苏州" }',
    ].join('\n');

    it('清单 → 目标 → 落库：行数与键完全等于枚举结果', async () => {
      const d = deps();
      const { destinations, errors } = parsePreheatManifest(MANIFEST);
      expect(errors).toEqual([]);

      const targets = preheatTargets(destinations);
      // 2 个目的地 × 13 个桶（12 具体 + general）
      expect(targets).toHaveLength(26);

      for (const target of targets) {
        const result = await generateAiAsset(d, target.request);
        expect(result.created).toBe(true);
      }

      const { rows } = await pool.query<{ cache_key: string }>(
        `SELECT cache_key FROM assets WHERE cache_key LIKE 'hero:v1:%' ORDER BY cache_key`,
      );
      const actual = rows.map((row) => row.cache_key);
      const expected = [...targets.map((target) => target.cacheKey)].sort();
      expect(actual).toEqual(expected);
    });

    it('AI 产物一律 AI_GENERATED + ILLUSTRATIVE（9.4，数据库另有 CHECK）', async () => {
      const d = deps();
      const [target] = preheatTargets([{ place_id: 'cn_hangzhou', name: '杭州' }], ['night_view']);
      await generateAiAsset(d, target!.request);

      const { rows } = await pool.query<{ source_type: string; representation_type: string }>(
        'SELECT source_type, representation_type FROM assets',
      );
      expect(rows[0]).toMatchObject({
        source_type: 'AI_GENERATED',
        representation_type: 'ILLUSTRATIVE',
      });
    });

    it('重跑整批不再生成：全部 created=false（19.5 的复用，也是重跑的成本前提）', async () => {
      const d = deps();
      const targets = preheatTargets([{ place_id: 'cn_hangzhou', name: '杭州' }]);

      for (const target of targets) await generateAiAsset(d, target.request);

      const second: boolean[] = [];
      for (const target of targets) {
        second.push((await generateAiAsset(d, target.request)).created);
      }
      expect(second.every((created) => created === false)).toBe(true);

      const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
      expect(rows[0]!.count).toBe('13');
    });

    it('收尾断言：预热之后，运行时形态的需求按键读得回来', async () => {
      /*
       * 这一条是整个预热的目的。前面几条验的是「灌进去了」，这一条验的是
       * 「用得上」—— 用 `cacheKeyFor`（运行时那一份）算键去查库，必须命中。
       *
       * 与 preheat-parity 的区别：那条是纯函数比字符串，这条走真实的
       * `findByCacheKey`，因此还覆盖了「键写进库时有没有被截断或改写」。
       */
      const d = deps();
      const destination = { place_id: 'cn_hangzhou', name: '杭州' } as const;
      const targets = preheatTargets([destination]);
      for (const target of targets) await generateAiAsset(d, target.request);

      const assets = createAssetsRepository(pool);

      for (const target of targets) {
        const runtimeKey = cacheKeyFor(heroRequirement(destination, BUCKET_THEME_PHRASE[target.bucket]));
        expect(runtimeKey).not.toBeNull();

        const hit = await assets.findByCacheKey(runtimeKey!);
        expect(hit, `桶 ${target.bucket} 的预热图按运行时键查不到`).not.toBeNull();
      }
    });
  });

  describe('轨道 B：清单 + 文件 → 落库', () => {
    it('合法条目落库，且 cache_key 为 null（它是库存而不是某个键的产物）', async () => {
      const d = deps();
      const { entries, errors } = parseSeedManifest(
        JSON.stringify({
          file: 'gongchen-01.png',
          role: 'DESTINATION_PHOTO',
          entity_name: '拱宸桥',
          destination_name: '杭州',
          destination_place_id: 'cn_hangzhou',
          license_type: 'CC0',
          style_tags: ['bridge', 'canal'],
        }),
      );
      expect(errors).toEqual([]);

      const result = await ingestAsset(d, ingestInputFor(entries[0]!, await photo(1200, 675)));
      expect(result.kind).toBe('ingested');

      const { rows } = await pool.query<{ cache_key: string | null; entity_name: string }>(
        'SELECT cache_key, entity_name FROM assets',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cache_key).toBeNull();
      expect(rows[0]?.entity_name).toBe('拱宸桥');
    });

    it('空文件被拒：11.2 解码不过，不写库也不上传', async () => {
      /*
       * 「用空文件代替」在轨道 B 上的正确预期是**被拒**，而不是入库成功 ——
       * 空字节 sharp 解不开。这条断言的价值在于确认拒绝发生在**写库之前**：
       * 若顺序反了，库里会留下一行指向不存在对象的素材，
       * 而它会被检索命中，页面上是裂图（ingest.ts L121-126 的理由）。
       */
      const d = deps();
      const { entries } = parseSeedManifest(
        JSON.stringify({ file: 'empty.png', role: 'FOOD_IMAGE', license_type: 'CC0' }),
      );

      const result = await ingestAsset(d, ingestInputFor(entries[0]!, new Uint8Array(0)));
      expect(result.kind).toBe('rejected');

      const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
      expect(rows[0]!.count).toBe('0');
      expect(d.storage.objects.size).toBe(0);
    });

    it('尺寸不达角色最小宽度被拒（Hero 要 1600）', async () => {
      const d = deps();
      const { entries } = parseSeedManifest(
        JSON.stringify({ file: 'small.png', role: 'HERO_BACKGROUND', license_type: 'CC0' }),
      );

      const result = await ingestAsset(d, ingestInputFor(entries[0]!, await photo(800, 300)));
      expect(result.kind).toBe('rejected');
    });

    it('三个角色按各自默认画幅入库', async () => {
      const d = deps();
      const cases = [
        { role: 'HERO_BACKGROUND' as const, width: 1600, height: 600 },
        { role: 'DESTINATION_PHOTO' as const, width: 1200, height: 675 },
        { role: 'FOOD_IMAGE' as const, width: 800, height: 600 },
      ];

      for (const [index, item] of cases.entries()) {
        const { entries } = parseSeedManifest(
          JSON.stringify({ file: `${index}.png`, role: item.role, license_type: 'CC0' }),
        );
        const bytes = await photo(item.width, item.height);
        const result = await ingestAsset(d, ingestInputFor(entries[0]!, bytes));
        expect(result.kind, `${item.role} 应当入库`).toBe('ingested');
      }

      const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM assets');
      expect(rows[0]!.count).toBe('3');
    });
  });

  it('两条轨道互不干扰：带键的与不带键的可以共存', async () => {
    /*
     * 现实里两者会在同一张表里并存。`assets_cache_key_uk` 是**部分**唯一索引
     * （`WHERE cache_key IS NOT NULL`），因此多行 null 不冲突 ——
     * 若哪天它被改成完整唯一索引，第二条种子素材就会写不进去。
     */
    const d = deps();
    const [target] = preheatTargets([{ place_id: 'cn_hangzhou', name: '杭州' }], ['canal_culture']);
    await generateAiAsset(d, target!.request);

    const { entries } = parseSeedManifest(
      [
        JSON.stringify({ file: 'a.png', role: 'DESTINATION_PHOTO', license_type: 'CC0' }),
        JSON.stringify({ file: 'b.png', role: 'DESTINATION_PHOTO', license_type: 'CC0' }),
      ].join('\n'),
    );

    for (const [index, entry] of entries.entries()) {
      // 尺寸略有差异，避免 content_hash 之外的意外合并
      const bytes = await photo(1200, 675 + index);
      const result = await ingestAsset(d, ingestInputFor(entry, bytes));
      expect(result.kind).toBe('ingested');
    }

    const { rows } = await pool.query<{ with_key: string; without_key: string }>(
      `SELECT count(*) FILTER (WHERE cache_key IS NOT NULL) AS with_key,
              count(*) FILTER (WHERE cache_key IS NULL)     AS without_key
         FROM assets`,
    );
    expect(rows[0]).toMatchObject({ with_key: '1', without_key: '2' });
  });
});
