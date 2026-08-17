import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalHashingEmbeddingClient } from '@tps/llm';
import { createAssetsRepository, createPool, loadDbConfig } from '@tps/db';
import { S3ObjectStorage, loadAssetsStorageConfig } from '@tps/storage';
import { createLogger } from '@tps/shared';
import { ingestAsset, type IngestResult } from './ingest.js';
import { PLACEHOLDER_SPECS, renderPlaceholder } from './placeholders.js';
import { ROLE_INGEST_DEFAULTS, parseSeedManifest } from './seed-manifest.js';

/**
 * 素材灌库 CLI（TP-3-06）。
 *
 * ```bash
 * # 按清单灌入已审核的素材
 * pnpm assets:ingest -- --manifest ./seeds/hangzhou.jsonl
 *
 * # 灌入十八章降级链需要的默认占位图（幂等，可重复执行）
 * pnpm assets:ingest -- --placeholders
 * ```
 *
 * 需要 `DATABASE_URL` 与 S3 四项环境变量。
 *
 * ## 清单有错行时整体不灌
 *
 * 见 `parseSeedManifest` 的说明：跳过错行等于「灌了 1998 条，两条静默丢失」。
 */

export interface CliArgs {
  readonly manifest: string | null;
  readonly placeholders: boolean;
  readonly dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let manifest: string | null = null;
  let placeholders = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--manifest 需要一个文件路径');
      }
      manifest = value;
      i += 1;
      continue;
    }
    if (arg === '--placeholders') {
      placeholders = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`未知参数 ${arg}`);
    }
  }

  if (manifest === null && !placeholders) {
    throw new Error('必须给出 --manifest <file> 或 --placeholders');
  }

  return { manifest, placeholders, dryRun };
}

export interface IngestSummary {
  readonly ingested: number;
  readonly reused: number;
  readonly rejected: readonly { readonly file: string; readonly reason: string }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ service: 'tps-assets-ingest', level: 'info' });

  const pool = createPool(loadDbConfig());
  const storage = new S3ObjectStorage(loadAssetsStorageConfig());
  const deps = {
    assets: createAssetsRepository(pool),
    storage,
    embedding: new LocalHashingEmbeddingClient(),
    logger,
  };

  let ingested = 0;
  let reused = 0;
  const rejected: { file: string; reason: string }[] = [];

  function record(file: string, result: IngestResult): void {
    if (result.kind === 'rejected') {
      rejected.push({ file, reason: result.rejection.reason });
      return;
    }
    if (result.created) ingested += 1;
    else reused += 1;
  }

  try {
    if (args.placeholders) {
      for (const spec of PLACEHOLDER_SPECS) {
        const bytes = await renderPlaceholder(spec);
        if (args.dryRun) {
          logger.info(
            { role: spec.role },
            `[dry-run] 占位图 ${spec.label}（${bytes.byteLength} 字节）`,
          );
          continue;
        }
        record(
          spec.cacheKey,
          await ingestAsset(deps, {
            bytes,
            entityName: null,
            destinationName: null,
            destinationPlaceId: null,
            title: spec.label,
            styleTags: ['placeholder'],
            licenseType: 'PLATFORM_OWNED',
            attributionText: null,
            licenseExpiresAt: null,
            sourceType: 'DEFAULT_PLACEHOLDER',
            // 占位图不是照片，必须标插画（9.4 的同一条原则）
            representationType: 'ILLUSTRATIVE',
            originalUrl: null,
            cacheKey: spec.cacheKey,
            generationMetadata: null,
            role: spec.role,
            aspectRatio: spec.aspectRatio,
            minWidth: spec.minWidth,
          }),
        );
      }
    }

    if (args.manifest !== null) {
      const manifestPath = path.resolve(args.manifest);
      const baseDir = path.dirname(manifestPath);
      const { entries, errors } = parseSeedManifest(await readFile(manifestPath, 'utf8'));

      if (errors.length > 0) {
        for (const error of errors) {
          logger.error({}, `清单第 ${error.line} 行：${error.message}`);
        }
        throw new Error(`清单有 ${errors.length} 行不合法，未灌入任何素材`);
      }

      logger.info({}, `清单共 ${entries.length} 条`);

      for (const entry of entries) {
        const defaults = ROLE_INGEST_DEFAULTS[entry.role];
        const bytes = new Uint8Array(await readFile(path.join(baseDir, entry.file)));

        if (args.dryRun) {
          logger.info({ role: entry.role }, `[dry-run] ${entry.file}`);
          continue;
        }

        record(
          entry.file,
          await ingestAsset(deps, {
            bytes,
            entityName: entry.entity_name,
            destinationName: entry.destination_name,
            destinationPlaceId: entry.destination_place_id,
            title: entry.title,
            styleTags: entry.style_tags,
            licenseType: entry.license_type,
            attributionText: entry.attribution_text,
            licenseExpiresAt:
              entry.license_expires_at === null ? null : new Date(entry.license_expires_at),
            sourceType: entry.source_type,
            representationType: entry.representation_type,
            originalUrl: entry.original_url,
            // 种子素材不带缓存键：它们不是「按某个键生成的产物」，
            // 而是可被多个键命中的库存（19.5 的复用发生在检索层）
            cacheKey: null,
            generationMetadata: null,
            role: entry.role,
            aspectRatio: entry.aspect_ratio ?? defaults.aspectRatio,
            minWidth: entry.min_width ?? defaults.minWidth,
          }),
        );
      }
    }

    logger.info({}, `灌库完成：新增 ${ingested} 条、复用 ${reused} 条、拒绝 ${rejected.length} 条`);
    for (const item of rejected) {
      logger.warn({}, `拒绝 ${item.file}：${item.reason}`);
    }
  } finally {
    storage.destroy();
    await pool.end();
  }

  // 有素材被拒时以非零码退出：CI 里「灌库通过」必须意味着全部灌进去了
  if (rejected.length > 0) process.exitCode = 1;
}

/*
 * 只有作为脚本执行时才跑 main —— 被测试 import 时不能有副作用
 * （测试只需要 parseArgs）。
 */
if (process.argv[1] !== undefined && process.argv[1].includes('ingest-cli')) {
  await main();
}
