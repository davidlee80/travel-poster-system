import { createHash } from 'node:crypto';

import { FakeLicensedSourceClient, LocalHashingEmbeddingClient } from '@tps/llm';
import type { LicensedSourceCandidate } from '@tps/llm';
import { SCHEMA_VERSIONS, SourceMetadataSchema, type AssetRequirementItem } from '@tps/schemas';
import type {
  AssetFingerprintRow,
  AssetsRepository,
  InsertAssetInput,
  MergeTagsInput,
} from '@tps/db';
import { InMemoryObjectStorage } from '@tps/storage';
import { createSilentLogger } from '@tps/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ALLOWED_SEARCH_MIME,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_QUALITY_FLOOR,
  buildSearchQueryText,
  ingestSearchResult,
} from './search-ingest.js';

/**
 * 9.6 自动入库流水线（TP-6-04/05，设计稿 9.6 的 R-46/R-47）。
 *
 * **不需要数据库**：仓储用进程内假实现。SQL 侧（部分唯一索引、标签并集的
 * 原子性）由 `packages/db` 的集成测试覆盖，这里验证的是**流水线的判定与顺序**
 * —— 哪些候选被丢弃、丢弃时有没有上传对象、打标取自哪里。
 *
 * 这个划分是有意的：门禁 #35 映射到本文件，而它必须**总是真的在跑**。
 * 做成集成测试的话，没有 DATABASE_URL 的环境里 vitest 会 describe.skip
 * 并以 0 退出，于是 `pnpm gate` 把它报成通过（P5 的 #34 就是这个问题）。
 */

/** 有高频细节、比例匹配的图 —— 通过 11.2 全部校验且质量分高 */
async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 7;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    pixels[i] = state % 256;
  }
  return new Uint8Array(
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

/**
 * 纯色图。`gray` 决定曝光分：
 *   - 128（中性灰）→ 清晰度 0、曝光 1.0、主体 0 = **恰好 0.30**
 *   - 10（严重欠曝）→ 曝光 0.078 = 0.023，远低于下限
 */
async function flatImage(width: number, height: number, gray: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: gray, g: gray, b: gray } },
    })
      .png()
      .toBuffer(),
  );
}

let goodPhoto: Uint8Array;
let lowQualityPhoto: Uint8Array;
let boundaryPhoto: Uint8Array;
let tinyPhoto: Uint8Array;

beforeAll(async () => {
  goodPhoto = await photo(1600, 900);
  lowQualityPhoto = await flatImage(1600, 900, 10);
  boundaryPhoto = await flatImage(1600, 900, 128);
  tinyPhoto = await photo(320, 180);
});

// ── 假仓储 ──────────────────────────────────────────────────

interface FakeRepo {
  readonly repo: AssetsRepository;
  readonly inserted: InsertAssetInput[];
  readonly merges: MergeTagsInput[];
  seed(hash: string, row: AssetFingerprintRow): void;
}

function fakeRepository(): FakeRepo {
  const inserted: InsertAssetInput[] = [];
  const merges: MergeTagsInput[] = [];
  const byHash = new Map<string, AssetFingerprintRow>();

  const repo: AssetsRepository = {
    findCandidates: () => Promise.resolve([]),
    findByCacheKey: () => Promise.resolve(null),
    findByContentHash: (hash) => Promise.resolve(byHash.get(hash) ?? null),
    mergeTags: (input) => {
      merges.push(input);
      return Promise.resolve();
    },
    insertAsset: (input) => {
      inserted.push(input);
      if (input.contentHash !== undefined) {
        byHash.set(input.contentHash, {
          assetId: input.assetId,
          status: 'ACTIVE',
          styleTags: input.styleTags,
          searchText: input.searchText,
        });
      }
      return Promise.resolve({ assetId: input.assetId, created: true });
    },
    insertVariant: () => Promise.resolve(),
  };

  return {
    repo,
    inserted,
    merges,
    seed: (hash, row) => byHash.set(hash, row),
  };
}

function deps(
  repo: AssetsRepository,
  client: FakeLicensedSourceClient,
): Parameters<typeof ingestSearchResult>[0] {
  return {
    assets: repo,
    storage: new InMemoryObjectStorage(),
    embedding: new LocalHashingEmbeddingClient(),
    logger: createSilentLogger(),
    search: client,
    searchTimeoutMs: 5_000,
    now: () => new Date('2026-08-19T08:00:00Z').getTime(),
  };
}

// ── 需求夹具 ────────────────────────────────────────────────

function requirement(overrides: Partial<AssetRequirementItem> = {}): AssetRequirementItem {
  return {
    schema_version: SCHEMA_VERSIONS.assetRequirement,
    slot_id: 'day_3.place.gongchen',
    day_number: 3,
    role: 'DESTINATION_PHOTO',
    asset_type: 'REAL_PHOTO_PREFERRED',
    required: false,
    subject: {
      destination: '杭州',
      destination_place_id: 'cn-hangzhou',
      entity_name: '拱宸桥',
      entity_place_id: 'hz-gongchen-bridge',
      theme: '运河人文·古今交融',
      entities: ['拱宸桥', '运河'],
    },
    visual_constraints: {
      aspect_ratio: '16:9',
      min_width: 1200,
      style: 'CHINESE_TRAVEL_EDITORIAL',
    },
    ...overrides,
  } as AssetRequirementItem;
}

function candidate(overrides: Partial<LicensedSourceCandidate> = {}): LicensedSourceCandidate {
  return {
    provider: 'fake-openverse',
    originalUrl: 'https://example.test/photos/1',
    downloadUrl: 'https://example.test/photos/1/full.jpg',
    licenseType: 'CC0',
    attributionText: '© 摄影者 / CC0',
    licenseExpiresAt: null,
    mimeType: 'image/jpeg',
    ...overrides,
  };
}

// ── 检索词构造 ──────────────────────────────────────────────

describe('buildSearchQueryText（9.6：检索词由槽位上下文构造）', () => {
  it('景点槽位含实体名与目的地', () => {
    const text = buildSearchQueryText(requirement());
    expect(text).toContain('拱宸桥');
    expect(text).toContain('杭州');
  });

  it('Hero 槽位无实体名，用主题短语', () => {
    const text = buildSearchQueryText(
      requirement({
        role: 'HERO_BACKGROUND',
        asset_type: 'AI_ILLUSTRATION',
        subject: {
          destination: '杭州',
          destination_place_id: 'cn-hangzhou',
          entity_name: null,
          theme: '运河人文·古今交融',
        },
      }),
    );
    expect(text).not.toBeNull();
    expect(text).toContain('杭州');
  });

  it('没有主体时返回 null（无从构造检索词，不该外呼）', () => {
    expect(buildSearchQueryText(requirement({ subject: null }))).toBeNull();
  });

  it('ROUTE_MAP 返回 null（9.2 的路线图是程序生成的）', () => {
    expect(
      buildSearchQueryText(
        requirement({ role: 'ROUTE_MAP', asset_type: 'GENERATED_SVG', required: true }),
      ),
    ).toBeNull();
  });
});

// ── 合规门禁（门禁 #35）─────────────────────────────────────

describe('license_type 门禁（9.6 / FR-3.4.5，门禁 #35）', () => {
  it('license_type 为空的候选被丢弃且不入库', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseType: null })],
      bytes: goodPhoto,
    });
    const d = deps(repo.repo, client);

    const outcome = await ingestSearchResult(d, requirement(), null);

    expect(outcome.assetId).toBeNull();
    expect(outcome.rejections).toEqual(['LICENSE_MISSING']);
    expect(repo.inserted).toHaveLength(0);
  });

  it('license_type 为空时**连下载都不发起**（省一次外呼与一次解码）', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseType: null })],
      bytes: goodPhoto,
    });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(client.downloadCalls).toHaveLength(0);
  });

  it('丢弃候选时不上传任何对象（不留孤儿文件）', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseType: null })],
      bytes: goodPhoto,
    });
    const storage = new InMemoryObjectStorage();

    await ingestSearchResult({ ...deps(repo.repo, client), storage }, requirement(), null);

    expect(storage.objects.size).toBe(0);
  });

  it('第一个候选不合规时继续试下一个', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseType: null }), candidate({ licenseType: 'LICENSED' })],
      bytes: goodPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.assetId).not.toBeNull();
    expect(outcome.rejections).toEqual(['LICENSE_MISSING']);
    expect(repo.inserted).toHaveLength(1);
  });
});

describe('MIME 白名单（9.6）', () => {
  it('白名单是三种常见位图格式', () => {
    // SVG 不在其中：外部 SVG 可含脚本与外链，而它会被直接嵌进导出页面
    expect([...ALLOWED_SEARCH_MIME]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('声明的 MIME 不在白名单时丢弃且不下载', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ mimeType: 'image/svg+xml' })],
      bytes: goodPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.rejections).toEqual(['MIME_NOT_ALLOWED']);
    expect(client.downloadCalls).toHaveLength(0);
  });

  it('图源没给 MIME 时照常下载，由 11.2 的解码校验兜底', async () => {
    /*
     * 不因为「没声明」就丢弃：多数图源的检索响应里没有 MIME 字段，
     * 一律丢弃等于这一层永不命中。真正的把关是 processImage 的
     * INVALID_IMAGE（sharp 解不开就是不合格），它看的是字节而不是声明。
     */
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ mimeType: null })],
      bytes: goodPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(client.downloadCalls).toHaveLength(1);
    expect(outcome.assetId).not.toBeNull();
  });
});

describe('11.2 后处理与质量下限（9.6）', () => {
  it('质量下限是 0.3', () => {
    expect(SEARCH_QUALITY_FLOOR).toBe(0.3);
  });

  it('分辨率不足的候选被拒并试下一个', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate(), candidate()],
      bytes: tinyPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.assetId).toBeNull();
    expect(outcome.rejections).toEqual(['POSTPROCESS_REJECTED', 'POSTPROCESS_REJECTED']);
  });

  it('质量分低于 0.3 的候选被丢弃', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate()],
      bytes: lowQualityPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.assetId).toBeNull();
    expect(outcome.rejections).toEqual(['QUALITY_TOO_LOW']);
    expect(repo.inserted).toHaveLength(0);
  });

  it('恰好等于 0.3 的候选**放行**（9.6 说的是「低于 0.3」）', async () => {
    /*
     * 边界钉在这里是有意的。中性灰纯色图的分数恰好是 0.30
     * （清晰度 0 × 0.4 + 曝光 1.0 × 0.3 + 主体 0 × 0.3），因此它是这条
     * 门禁唯一能被精确构造的边界样本。
     *
     * 把它写成用例而不是留给实现细节：`<` 与 `<=` 的差别只在这一个点上
     * 显现，而两者都「看起来对」。哪天有人改成 `<=`，这条会红，
     * 而那正是一次需要回到 9.6 原文确认的改动。
     *
     * 顺带记下一个已知的松处：清晰度为 0 的图（完全没有信息）能通过
     * 这道门禁，靠的是曝光项的满分。9.6 只给了 quality_score 一个总分下限，
     * 没有分项下限，因此不在这里自行加规则 —— 真实图源返回纯色图的概率
     * 极低，且它仍要过分辨率与比例两道门禁。
     */
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate()],
      bytes: boundaryPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.rejections).toEqual([]);
    expect(repo.inserted[0]?.qualityScore).toBe(SEARCH_QUALITY_FLOOR);
  });

  it('下载失败的候选被记 DOWNLOAD_FAILED 并试下一个', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate(), candidate()],
      downloadBehaviors: ['unavailable'],
      bytes: goodPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.rejections).toEqual(['DOWNLOAD_FAILED']);
    expect(outcome.assetId).not.toBeNull();
  });

  it('候选数不超过 SEARCH_CANDIDATE_LIMIT', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: Array.from({ length: 20 }, () => candidate({ licenseType: null })),
      bytes: goodPhoto,
    });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.rejections).toHaveLength(SEARCH_CANDIDATE_LIMIT);
    expect(client.searchCalls[0]?.limit).toBe(SEARCH_CANDIDATE_LIMIT);
  });
});

// ── 打标与来源元数据（门禁 #35）─────────────────────────────

describe('自动打标取自 AssetRequirement（9.6：不做图像理解）', () => {
  it('实体名、目的地、place_id 全部来自 subject', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(repo.inserted[0]).toMatchObject({
      entityName: '拱宸桥',
      destinationName: '杭州',
      destinationPlaceId: 'cn-hangzhou',
      sourceType: 'LICENSED_SOURCE',
      representationType: 'PHOTOGRAPHIC',
      licenseType: 'CC0',
    });
  });

  it('Hero 的 entityName 为 null（9.3：Hero 表达主题而非某个地点）', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(
      deps(repo.repo, client),
      requirement({
        role: 'HERO_BACKGROUND',
        asset_type: 'AI_ILLUSTRATION',
        visual_constraints: { aspect_ratio: '16:9', min_width: 1200 },
      }),
      null,
    );

    expect(repo.inserted[0]?.entityName).toBeNull();
  });

  it('标签与图片内容矛盾时仍取 subject（打标来源是上下文，不是图像）', async () => {
    /*
     * 9.6 的理由：上下文标签错，至多是这张图检索排序不准；视觉模型标签错，
     * 会把图归到不相干的 POI 名下。这条用例把「图是随机噪声、subject 说是
     * 灵隐寺」构造出来，断言库里记的是灵隐寺。
     */
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(
      deps(repo.repo, client),
      requirement({
        subject: {
          destination: '杭州',
          destination_place_id: 'cn-hangzhou',
          entity_name: '灵隐寺',
          entity_place_id: 'hz-lingyin',
        },
      }),
      null,
    );

    expect(repo.inserted[0]?.entityName).toBe('灵隐寺');
  });

  it('style_tags 含视觉风格与主题桶，且带 provider 标记', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    const tags = repo.inserted[0]?.styleTags ?? [];
    expect(tags).toContain('chinese_travel_editorial');
    expect(tags).toContain('canal_culture');
    expect(tags).toContain('provider:fake-openverse');
  });

  it('缓存键被写入（下次同上下文请求走 19.4 的精确命中）', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });
    const cacheKey = 'place:v1:hz-gongchen-bridge:destination_photo:16x9';

    await ingestSearchResult(deps(repo.repo, client), requirement(), cacheKey);

    expect(repo.inserted[0]?.cacheKey).toBe(cacheKey);
  });
});

describe('source_metadata 逐字段（9.6 必填，门禁 #35）', () => {
  it('四项内容齐全且可被 SourceMetadataSchema 解析', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [
        candidate({
          provider: 'openverse',
          originalUrl: 'https://openverse.test/image/abc',
          licenseType: 'LICENSED',
          licenseExpiresAt: new Date('2030-01-01T00:00:00Z'),
        }),
      ],
      bytes: goodPhoto,
    });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    const parsed = SourceMetadataSchema.parse(repo.inserted[0]?.sourceMetadata);
    expect(parsed.provider).toBe('openverse');
    expect(parsed.original_url).toBe('https://openverse.test/image/abc');
    expect(parsed.search_query).toContain('拱宸桥');
    expect(parsed.license).toBe('LICENSED');
    expect(parsed.license_expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(parsed.retrieved_at).toBe('2026-08-19T08:00:00.000Z');
  });

  it('永久授权时 license_expires_at 为 null 而不是缺键', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseExpiresAt: null })],
      bytes: goodPhoto,
    });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    const parsed = SourceMetadataSchema.parse(repo.inserted[0]?.sourceMetadata);
    expect(parsed.license_expires_at).toBeNull();
    // 同时落进列，19.3 据此让到期素材自动退出检索
    expect(repo.inserted[0]?.licenseExpiresAt).toBeNull();
  });

  it('license_expires_at 同时写入列（19.3 的自动退出检索）', async () => {
    const repo = fakeRepository();
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const client = new FakeLicensedSourceClient({
      candidates: [candidate({ licenseExpiresAt: expiresAt })],
      bytes: goodPhoto,
    });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(repo.inserted[0]?.licenseExpiresAt).toEqual(expiresAt);
  });
});

describe('content_hash 写入（R-47）', () => {
  it('落库的指纹是原图字节的 SHA-256', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    const expected = createHash('sha256').update(goodPhoto).digest('hex');
    expect(repo.inserted[0]?.contentHash).toBe(expected);
  });

  it('指纹算的是**原图**而不是转码后的 WebP', async () => {
    /*
     * 转码后的字节依赖 sharp/libvips 的版本与质量参数 —— 升一次依赖，
     * 同一张原图的指纹就全变了，去重从此失效而没有任何报错。
     */
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    const webpHash = createHash('sha256')
      .update(await sharp(goodPhoto).webp().toBuffer())
      .digest('hex');
    expect(repo.inserted[0]?.contentHash).not.toBe(webpHash);
  });
});

describe('搜索为空', () => {
  it('图源返回零候选时不记任何丢弃原因（那不是失败）', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [], bytes: goodPhoto });

    const outcome = await ingestSearchResult(deps(repo.repo, client), requirement(), null);

    expect(outcome.assetId).toBeNull();
    expect(outcome.rejections).toEqual([]);
    expect(outcome.searched).toBe(true);
  });

  it('算不出检索词时压根不调用图源', async () => {
    const repo = fakeRepository();
    const client = new FakeLicensedSourceClient({ candidates: [candidate()], bytes: goodPhoto });

    const outcome = await ingestSearchResult(
      deps(repo.repo, client),
      requirement({ subject: null }),
      null,
    );

    expect(outcome.searched).toBe(false);
    expect(client.searchCalls).toHaveLength(0);
  });
});
