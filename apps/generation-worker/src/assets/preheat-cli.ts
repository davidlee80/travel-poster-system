import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createAssetsRepository, createPool, loadDbConfig } from '@tps/db';
import { LocalHashingEmbeddingClient, createImageClient, loadImageConfig } from '@tps/llm';
import { S3ObjectStorage, loadAssetsStorageConfig } from '@tps/storage';
import { createLogger } from '@tps/shared';

import { mapWithConcurrency } from './concurrency.js';
import { renderFakeGeneratedImage } from './fake-image.js';
import { generateAiAsset } from './generate-asset.js';
import { parsePreheatManifest, preheatTargets } from './preheat.js';

/**
 * 19.5 Hero 预热 CLI（TP-4-05）。
 *
 * ```bash
 * # 先看要生成多少、键长什么样（不花钱）
 * pnpm assets:preheat -- --manifest ./infrastructure/seed/preheat-destinations.jsonl --dry-run
 *
 * # 真的生成（需要 IMAGE_MODE=direct|gateway 才会产出插画）
 * pnpm assets:preheat -- --manifest ./infrastructure/seed/preheat-destinations.jsonl
 * ```
 *
 * 需要 `DATABASE_URL`、S3 四项、以及 `IMAGE_*`。
 *
 * ## 为什么并发只有 4
 *
 * 21.2 的「AI 图片生成：全任务 3、全局 20」是**在线**路径的并发。预热是离线
 * 批量作业，它与在线请求争夺的是同一个供应商速率配额 —— 把预热开到 20 会让
 * 正在等页面的用户排在 600 张预热图后面。4 是「跑得完」与「不挤占在线」
 * 之间的取值：600 张 × 20 秒 ÷ 4 ≈ 50 分钟，属于可接受的上线前准备时间。
 */

export interface PreheatCliArgs {
  readonly manifest: string;
  readonly dryRun: boolean;
  /** 只跑前 N 个目标，便于先验证一小批的画面质量再全量跑 */
  readonly limit: number | null;
}

export const PREHEAT_CONCURRENCY = 4;

/**
 * 连续失败到这个数且**一张都没成功**时中止整批。
 *
 * 这一条针对的是配置错误（S3 地址不对、图片凭据没配）：那种情况下 600 个
 * 目标会一个个失败，每个都要等超时，最后打印 600 行同样的错误。
 * 先失败 5 个就停下来，操作者立刻能看出「不是个别目标的问题」。
 */
export const PREHEAT_ABORT_AFTER_FAILURES = 5;

/**
 * 把异常变成一行有用的说明。
 *
 * 直接 `String(error)` 对 `AggregateError` 只会给出「AggregateError」——
 * 而 S3 客户端连不上时抛的正是它（多个候选地址各失败一次）。
 * 一个只会说 AggregateError 的运维 CLI 等于没有错误信息。
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [error.message.length > 0 ? `${error.name}: ${error.message}` : error.name];
  if (error instanceof AggregateError) {
    const first = error.errors.find((inner): inner is Error => inner instanceof Error);
    if (first !== undefined) parts.push(`首个原因 ${first.name}: ${first.message}`);
  } else if (error.cause instanceof Error) {
    parts.push(`原因 ${error.cause.name}: ${error.cause.message}`);
  }
  return parts.join('；');
}

export function parsePreheatArgs(argv: readonly string[]): PreheatCliArgs {
  let manifest: string | null = null;
  let dryRun = false;
  let limit: number | null = null;

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
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--limit 需要一个正整数');
      }
      limit = value;
      i += 1;
      continue;
    }
    /*
     * `pnpm <script> -- --flag` 会把分隔符本身也传进来。忽略它而不是报错 ——
     * 而 `--flag` 拼错时仍然报错（打错的参数静默不生效才是真问题）。
     */
    if (arg === '--') continue;
    if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`未知参数 ${arg}`);
    }
  }

  if (manifest === null) throw new Error('必须给出 --manifest <file>');
  return { manifest, dryRun, limit };
}

async function main(): Promise<void> {
  const args = parsePreheatArgs(process.argv.slice(2));
  const logger = createLogger({ service: 'tps-assets-preheat', level: 'info' });

  const { destinations, errors } = parsePreheatManifest(
    await readFile(path.resolve(args.manifest), 'utf8'),
  );
  if (errors.length > 0) {
    for (const error of errors) logger.error({}, `清单第 ${error.line} 行：${error.message}`);
    throw new Error(`清单有 ${errors.length} 行不合法，未生成任何素材`);
  }

  const all = preheatTargets(destinations);
  const targets = args.limit === null ? all : all.slice(0, args.limit);

  logger.info(
    {},
    `${destinations.length} 个目的地 × ${all.length / Math.max(1, destinations.length)} 个主题桶 ` +
      `= ${all.length} 个目标${args.limit === null ? '' : `，本次只跑前 ${targets.length} 个`}`,
  );

  if (args.dryRun) {
    for (const target of targets) {
      logger.info(
        { role: 'HERO_BACKGROUND' },
        `[dry-run] ${target.destination.name} / ${target.bucket} → ${target.cacheKey}`,
      );
    }
    return;
  }

  const imageConfig = loadImageConfig();
  if (imageConfig.mode === 'fake') {
    /*
     * 警告而不是拒绝：fake 模式下预热仍然有用（它把整条管道与 600 行素材
     * 真的建起来，可以验证键、复用与 13.4 的取数）。但产物是渐变图，
     * 不能当成上线前的预热完成 —— 不说清楚的话，线上会以「Hero 全是灰蓝渐变」
     * 的形式暴露，而缓存命中率指标一切正常。
     */
    logger.warn(
      {},
      'IMAGE_MODE=fake：产物是渐变占位图而不是插画，仅用于打通链路，不可作为上线预热',
    );
  }

  const pool = createPool(loadDbConfig());
  const storage = new S3ObjectStorage(loadAssetsStorageConfig());
  const deps = {
    assets: createAssetsRepository(pool),
    storage,
    embedding: new LocalHashingEmbeddingClient(),
    logger,
    image: createImageClient(imageConfig, { renderer: renderFakeGeneratedImage }),
    imageTimeoutMs: imageConfig.timeoutMs,
  };

  let created = 0;
  let reused = 0;
  const failed: { cacheKey: string; reason: string }[] = [];

  try {
    await mapWithConcurrency(targets, PREHEAT_CONCURRENCY, async (target) => {
      try {
        const result = await generateAiAsset(deps, target.request);
        if (result.created) created += 1;
        else reused += 1;
      } catch (error) {
        /*
         * 单个目标失败不中断整批：600 个目标里若有一个因供应商瞬时错误失败，
         * 中断意味着前面 400 个的成本要在重跑时被重新评估
         * （虽然它们会命中缓存，但操作者无从知道跑到哪了）。
         * 失败清单在末尾一次列出，可用 --manifest 缩小范围重跑。
         */
        failed.push({ cacheKey: target.cacheKey, reason: describeError(error) });
        if (created + reused === 0 && failed.length >= PREHEAT_ABORT_AFTER_FAILURES) {
          throw new Error(
            `连续 ${failed.length} 个目标全部失败且无一成功，中止整批。` +
              `多半是配置问题（S3 / IMAGE_*）：${failed[0]?.reason ?? ''}`,
          );
        }
      }
      return null;
    });

    logger.info({}, `预热完成：新增 ${created} 张、已存在 ${reused} 张、失败 ${failed.length} 个`);
    for (const item of failed) logger.warn({}, `失败 ${item.cacheKey}：${item.reason}`);
  } finally {
    storage.destroy();
    await pool.end();
  }

  // 有失败时非零退出：「预热通过」必须意味着 600 个键全部就位
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && process.argv[1].includes('preheat-cli')) {
  await main();
}
