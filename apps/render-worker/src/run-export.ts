import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { ExportJobPayloadSchema, withRestoredTrace } from '@tps/queue';

import {
  ExportLeaseLostError,
  type ExportExecutionRepository,
  type ExportJobRow,
  type ExportsRepository,
  type PresentationsRepository,
} from '@tps/db';
import {
  ExportArtifactSchema,
  EXPORT_URL_TTL_SECONDS,
  type ExportArtifact,
  type ExportArtifactFormat,
} from '@tps/schemas';
import { RENDER_PAGE_KEYS, issueRenderToken, type Logger } from '@tps/shared';
import {
  exportFileName,
  exportObjectKeyFor,
  type ContentSpace,
  type ExportStorage,
} from '@tps/storage';
import type { Browser, BrowserContext } from 'playwright-core';

import { createRenderContext } from './browser.js';
import { buildDailyPngZip } from './daily-png-zip.js';
import { capturePdf, mergePdfs } from './pdf.js';
import { capturePng } from './png.js';
import { recordRenderFailure, recordRenderQuality } from './render-metrics.js';
import { renderPage } from './render-page.js';

/**
 * 导出任务的执行（TP-4-12，设计稿 13.5 的产物组织、13.6、16.3）。
 *
 * 与 `export-plan.ts` 的分工：那一条是 **CLI 路径**（P1 的视觉基线），
 * 产物写本地目录、串行渲染以保证可复现。这一条是**队列路径**：
 * 产物进对象存储、状态回写 `exports` 行、失败按 16.3 判定。
 *
 * 两者共用 `renderPage` / `capturePng` / `capturePdf` / `mergePdfs` ——
 * 也就是「怎么渲染」只有一份实现，而「产物去哪里」各自不同。
 *
 * ## 13.5 的产物组织
 *
 * ```text
 * PNG + SINGLE_DAY   1 个 PNG
 * PNG + ALL_DAYS     N 个 PNG，files[] 按 day_number 升序
 * PNG + FULL_PLAN    1 个整页 PNG
 * PDF + SINGLE_DAY   1 个单页 PDF
 * PDF + ALL_DAYS     **1 个 N 页 PDF**（不是 N 个文件）
 * PDF + FULL_PLAN    1 个多页 PDF
 * PNG + ALL_DAYS     还会附加 1 个 ZIP，供浏览器一键下载全部每日图
 * ```
 *
 * ## PARTIAL 的判定（13.6）
 *
 * 「`ALL_DAYS` 下部分天导出失败但至少一天成功时返回 `PARTIAL` + 成功项，
 * 而不是整体 `FAILED`」。对 PDF 的 `ALL_DAYS` 这一条有个后果值得写下来：
 * 产物是**合并后的一个文件**，因此「部分天失败」意味着那个 PDF 少了几页。
 * 仍然交付它 —— 12 页的行程比零页有用，而 `PARTIAL` + `error` 已经如实
 * 说明了缺失。悄悄交付一个完整的假象才是不能做的事。
 */

export interface RunExportDeps {
  readonly exports: ExportsRepository;
  readonly execution: ExportExecutionRepository;
  /** `ALL_DAYS` 的天号来自这里，见 `listDayNumbers` 的说明 */
  readonly presentations: Pick<PresentationsRepository, 'listDayNumbers'>;
  readonly storage: ExportStorage;
  readonly browser: Browser | (() => Promise<Browser>);
  /** 渲染服务的基地址，形如 `http://web:3000` */
  readonly baseUrl: string;
  /** 17.1 的渲染令牌签名密钥 */
  readonly signingKey: string;
  readonly logger: Logger;
}

/**
 * 结局带上 format/scope/userType，供 21.3 的两个导出指标分组
 * （21.2 的分环节耗时目标按 format+scope，R-13 的身份维度按 userType）。
 */
interface ExportShape {
  readonly format: 'PNG' | 'PDF';
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly userType: 'ANONYMOUS' | 'REGISTERED';
}

export type RunExportOutcome =
  | ({ readonly kind: 'completed'; readonly files: number } & ExportShape)
  | ({
      readonly kind: 'partial';
      readonly files: number;
      readonly failed: readonly number[];
    } & ExportShape)
  | ({ readonly kind: 'busy' } & ExportShape)
  | ({ readonly kind: 'failed'; readonly errorCode: string } & ExportShape)
  | { readonly kind: 'skipped'; readonly reason: 'not_found' | 'not_queued' };

/** 一页渲染 + 抓取的结果 */
interface Captured {
  readonly dayNumber: number | null;
  readonly bytes: Uint8Array;
  readonly degraded: boolean;
}

export async function processExportJob(
  deps: RunExportDeps,
  job: Job,
  token?: string,
  report?: (outcome: RunExportOutcome) => void,
): Promise<void> {
  const payload = ExportJobPayloadSchema.parse(job.data);
  await withRestoredTrace(payload.traceContext, async () => {
    const outcome = await runExport(deps, payload.exportId, {
      attempt: job.attemptsMade + 1,
      attempts: job.opts.attempts ?? 2,
    });
    if (outcome.kind === 'busy') {
      await job.moveToDelayed(Date.now() + 1000, token);
      throw new DelayedError();
    }
    report?.(outcome);
    if (outcome.kind === 'failed') throw new Error(outcome.errorCode);
  });
}

export async function runExport(
  deps: RunExportDeps,
  exportId: string,
  attempt = { attempt: 1, attempts: 2 },
): Promise<RunExportOutcome> {
  const row = await deps.exports.findById(exportId);
  if (row === null) {
    /*
     * 任务不存在：多半是保留期清理删掉了用户，而队列里还留着消息。
     * 与生成侧同一处理 —— 静默跳过而不是报错，报错会让 BullMQ 反复重试
     * 一个永远不会存在的任务。
     */
    deps.logger.warn({}, '导出任务不存在，跳过');
    return { kind: 'skipped', reason: 'not_found' };
  }

  const shape = { format: row.format, scope: row.scope, userType: row.userType };
  const claim = await deps.execution.claim(exportId, attempt.attempt);
  if (claim.kind === 'busy') return { kind: 'busy', ...shape };
  if (claim.kind !== 'acquired') return { kind: 'skipped', reason: 'not_queued' };
  const lease = claim.lease;
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const renew = (): void => {
    renewal = deps.execution
      .renew(lease)
      .then((ok) => {
        lost = !ok;
      })
      .catch((error: unknown) => {
        lost = true;
        deps.logger.warn({ err: error, export_id: exportId }, '导出租约续期失败，停止本次提交');
      })
      .finally(() => {
        if (!stopped && !lost) {
          timer = setTimeout(renew, 10000);
          timer.unref();
        }
      });
  };
  timer = setTimeout(renew, 10000);
  timer.unref();
  const assertLease = async (): Promise<void> => {
    if (lost || !(await deps.execution.renew(lease))) throw new ExportLeaseLostError();
  };
  try {
    /*
     * `ALL_DAYS` 要渲染「实际落了 ViewModel 的那些天」，而不是请求里的天数：
     * 编排失败时两者不一致，按后者渲染会对不存在的页面发请求。
     *
     * 必须带 `row.templateId`（R-85）：一个版本下可以共存多套模板的展示数据，
     * 不过滤的话 14 天会变 28 行，于是这里渲染 28 页 —— 时长翻倍、
     * 按页计费翻倍，而任务状态是 COMPLETED。
     */
    const days =
      row.scope === 'ALL_DAYS'
        ? await deps.presentations.listDayNumbers(row.planVersionId, row.templateId)
        : row.dayNumbers;
    const pages = pagesFor(row.scope, days, row.planVersionId);
    const browser = typeof deps.browser === 'function' ? await deps.browser() : deps.browser;
    const context = await createRenderContext(browser);

    const captured: Captured[] = [];
    const failedDays: number[] = [];

    try {
      for (const page of pages) {
        await assertLease();
        try {
          captured.push(
            await capture(deps, context, row.planVersionId, row.templateId, row.format, page),
          );
        } catch (error) {
          /*
           * 单页失败不中断整批（13.6 的 PARTIAL）。记下天号，最后一起报告。
           * 中断的话，一个 14 天导出会因为第 3 天的一次瞬时失败而全部作废，
           * 而前两天已经渲染完的成本白花。
           */
          failedDays.push(page.dayNumber ?? 0);
          // R-42：失败原因进指标，21.3 的字体故障告警据此判定
          recordRenderFailure(error);
          deps.logger.warn(
            { format: row.format, page_type: page.dayNumber === null ? 'full' : 'day' },
            `第 ${page.dayNumber ?? 0} 页导出失败：${String(error)}`,
          );
        }
      }
    } finally {
      await context.close();
    }

    if (captured.length === 0) {
      throw new Error(row.format === 'PNG' ? 'EXPORT_PNG_FAILED' : 'EXPORT_PDF_FAILED');
    }
    await assertLease();

    const artifacts = await upload(
      {
        ...deps,
        storage: {
          put: async (input) => {
            await assertLease();
            await deps.execution.registerArtifact(lease, input.key);
            await deps.storage.put(input);
          },
          presign: (key, ttl, options) => deps.storage.presign(key, ttl, options),
          delete: (keys) => deps.storage.delete(keys),
        },
      },
      contentSpaceOf(row),
      `${row.exportId}/attempts/${lease.token}`,
      row.format,
      row.scope,
      captured,
    );

    const partial = failedDays.length > 0;
    await assertLease();
    if (
      !(await deps.execution.finish(lease, {
        exportId,
        status: partial ? 'PARTIAL' : 'COMPLETED',
        files: artifacts,
        errorCode: partial
          ? row.format === 'PNG'
            ? 'EXPORT_PNG_FAILED'
            : 'EXPORT_PDF_FAILED'
          : null,
        ...(partial ? { errorDetail: { failed_days: failedDays } } : {}),
      }))
    )
      throw new ExportLeaseLostError();
    return partial
      ? { kind: 'partial', files: artifacts.length, failed: failedDays, ...shape }
      : { kind: 'completed', files: artifacts.length, ...shape };
  } catch (error) {
    // 提交成功后连接中断也不能退款或删除已经发布的文件。
    const current = await deps.exports.findById(exportId);
    if (current === null || ['COMPLETED', 'PARTIAL', 'FAILED'].includes(current.status)) {
      return { kind: 'skipped', reason: current === null ? 'not_found' : 'not_queued' };
    }
    if (error instanceof ExportLeaseLostError || lost) return { kind: 'busy', ...shape };
    const errorCode = row.format === 'PNG' ? 'EXPORT_PNG_FAILED' : 'EXPORT_PDF_FAILED';
    deps.logger.warn({ err: error, export_id: exportId }, '导出尝试失败');
    const changed =
      attempt.attempt < attempt.attempts
        ? await deps.execution.retry(lease, errorCode)
        : await deps.execution.finish(lease, { exportId, status: 'FAILED', files: [], errorCode });
    return changed ? { kind: 'failed', errorCode, ...shape } : { kind: 'busy', ...shape };
  } finally {
    stopped = true;
    clearTimeout(timer);
    await renewal;
  }
}

/** 恢复只收尾最终失败任务和未发布尝试，不重放历史任务。 */
export async function recoverExports(deps: {
  readonly execution: ExportExecutionRepository;
  readonly storage: ExportStorage;
  readonly logger: Logger;
  readonly failedJobs: readonly { exportId: string; errorCode: string }[];
}): Promise<void> {
  const jobs = [...deps.failedJobs, ...(await deps.execution.pendingFinalizations())];
  for (const job of jobs) {
    try {
      await deps.execution.failAbandoned(
        job.exportId,
        job.errorCode.slice(0, 60) || 'EXPORT_PNG_FAILED',
      );
    } catch (error) {
      deps.logger.warn({ err: error, export_id: job.exportId }, '导出最终收尾失败，下轮继续');
    }
  }
  for (const artifact of await deps.execution.pendingArtifacts()) {
    try {
      await deps.storage.delete([artifact.key]);
      await deps.execution.deferArtifact(artifact.token, artifact.key);
    } catch (error) {
      deps.logger.warn(
        { err: error, attempt_token: artifact.token },
        '导出尝试产物清理失败，下轮继续',
      );
    }
  }
}

/**
 * 导出行 → 15.4 的产物空间（TP-6-12）。
 *
 * 单独一个导出的纯函数，而不是在 `runExport` 里内联对象字面量：
 * 这四个字段的映射是**唯一**可能写错的地方（比如把 `planId` 当成
 * `content_id`、或者把 `exports.created_at` 当成版本行的创建时刻），
 * 而 `runExport` 的主体需要真实 Chromium + web 服务 + MinIO 三者同时在位
 * 才能跑（P4 的交付边界 4），因此内联的话这个映射永远没有单测覆盖。
 *
 * 写错的表现极隐蔽：键仍然合法、上传仍然成功、下载仍然可用 ——
 * 只有 retention 的对象清理会因为推不出同一个键而漏删（那时已经晚了）。
 */
export function contentSpaceOf(row: ExportJobRow): ContentSpace {
  return {
    userType: row.userType,
    userId: row.userId,
    // `content_id` 就是 `plan_version_id`（R-48），不是 plan_id
    contentId: row.planVersionId,
    contentCreatedAt: row.planVersionCreatedAt,
  };
}

export interface PageTarget {
  readonly dayNumber: number | null;
  readonly path: string;
  readonly pageKey: string;
}

/** scope → 要渲染的页面列表（13.5 的产物组织） */
export function pagesFor(
  scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN',
  dayNumbers: readonly number[] | null,
  planVersionId: string,
): readonly PageTarget[] {
  const encoded = encodeURIComponent(planVersionId);

  if (scope === 'FULL_PLAN') {
    return [
      {
        dayNumber: null,
        path: `/render/plans/${encoded}/full`,
        pageKey: RENDER_PAGE_KEYS.full(),
      },
    ];
  }

  /*
   * `ALL_DAYS` 的天号由调用方从 `plan_presentations` 查出后传进来
   * （`exports.day_numbers` 对非 SINGLE_DAY 恒为 null）。
   * 空或 null 时返回空列表 —— 调用方会因此得到 `FAILED`，而那是对的：
   * 一个没有任何展示页的版本确实无法导出。默认渲染第 1 天会产出一份
   * 「只有第一天」的 PDF 并标成 COMPLETED，那种静默的错误更糟。
   */
  const days = dayNumbers ?? [];

  return days.map((dayNumber) => ({
    dayNumber,
    path: `/render/plans/${encoded}/days/${dayNumber}`,
    pageKey: RENDER_PAGE_KEYS.day(dayNumber),
  }));
}

async function capture(
  deps: RunExportDeps,
  context: BrowserContext,
  planVersionId: string,
  /**
   * 本次导出的样式套件（R-85），来自 `exports.template_id`。
   *
   * 类型是 `string` 而不是 `TemplateId`：那一列是 `VARCHAR(100)` 且无 CHECK
   * （刻意如此 —— 新增套件不需要迁移），因此库里的值在类型层面无法
   * 保证属于枚举。它的实际边界来自导出接口的 Zod 校验
   * （`ExportRequestSchema` 用 `TemplateIdSchema`），而不是这里的声明。
   * 标成 `TemplateId` 会需要一次转型，而那只是把不确定性藏起来。
   */
  templateId: string,
  format: 'PNG' | 'PDF',
  target: PageTarget,
): Promise<Captured> {
  const rendered = await renderPage({
    context,
    baseUrl: deps.baseUrl,
    path: target.path,
    templateId,
    // 每页一个新令牌：令牌与页面绑定，jti 唯一以支持重放检测（17.1）
    renderToken: issueRenderToken(
      { planVersionId, pageKey: target.pageKey, jti: randomUUID() },
      deps.signingKey,
    ),
  });

  /*
   * 渲染质量观测（TP-5-01）：轮次分布、降级计数与图标缺失。
   * 放在抓取**之前**：即使 PNG/PDF 生成失败，这一页的渲染质量数据仍然有效
   * —— 而那种情况下它恰恰更有用（排查「为什么这一页导不出来」）。
   */
  const pageType = target.dayNumber === null ? 'full' : 'day';
  recordRenderQuality({
    pageType,
    /*
     * 报实际渲染的那一套（R-85）。原先这个标签由 `recordRenderQuality`
     * 内部从 `TEMPLATE_BY_PAGE_TYPE[pageType]` 反推 —— 一张把页型当模板的
     * 硬编码表，多套样式后它会恒为错。
     */
    templateId,
    round: rendered.round,
    degraded: rendered.degraded,
    missingIcons: rendered.missingIcons,
    images: rendered.images,
  });

  /*
   * 素材图片加载失败要留下痕迹。
   *
   * 这一段是纯日志，不改变结局 —— 十八章的降级链要求坏图不阻断导出，
   * 那个决定保持不变。补日志的理由是它此前**完全不可见**：图片全部取不到时
   * 页面仍然 ready、degraded 仍是 false、导出仍然 COMPLETED，
   * 用户拿到一张图片位置全空白的长图，而日志里一个字都没有。
   *
   * 全坏与部分坏用不同级别：全坏几乎一定是配置问题
   * （S3_PUBLIC_BASE_URL 在渲染容器里解析不到、素材桶不允许匿名读），
   * 而少数坏图是降级链在正常工作。
   */
  if (rendered.images.broken > 0) {
    const allBroken = rendered.images.broken === rendered.images.total;
    const detail = {
      page_type: pageType,
      broken: rendered.images.broken,
      total: rendered.images.total,
    };
    if (allBroken) {
      deps.logger.error(
        detail,
        `第 ${target.dayNumber ?? 0} 页的 ${rendered.images.total} 张素材图片全部加载失败 —— ` +
          '检查 S3_PUBLIC_BASE_URL 在渲染容器内是否可解析、素材桶是否允许匿名读',
      );
    } else {
      deps.logger.warn(
        detail,
        `第 ${target.dayNumber ?? 0} 页有 ${rendered.images.broken}/${rendered.images.total} 张素材图片加载失败`,
      );
    }
  }

  try {
    const bytes =
      format === 'PNG' ? (await capturePng(rendered.page)).buffer : await capturePdf(rendered.page);

    return { dayNumber: target.dayNumber, bytes, degraded: rendered.degraded };
  } finally {
    await rendered.page.close();
  }
}

/** 上传并构造 `ExportArtifact[]`（含 storage_key，重签名要用） */
async function upload(
  deps: RunExportDeps,
  space: ContentSpace,
  exportId: string,
  format: 'PNG' | 'PDF',
  scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN',
  captured: readonly Captured[],
): Promise<readonly ExportArtifact[]> {
  const contentType = format === 'PNG' ? 'image/png' : 'application/pdf';

  /*
   * 13.5：`PDF` + `ALL_DAYS` 产**一个 N 页文件**，页序 = 天序。
   * 合并而不是返回 N 个 PDF —— 用户要的是一份能打印的行程，
   * 而 14 个单页 PDF 需要他自己按文件名排序再合并。
   */
  if (format === 'PDF' && scope === 'ALL_DAYS') {
    const ordered = [...captured].sort((a, b) => (a.dayNumber ?? 0) - (b.dayNumber ?? 0));
    const combined =
      ordered.length === 1
        ? ordered[0]!.bytes
        : await mergePdfs(ordered.map((item) => Buffer.from(item.bytes)));
    return [await putOne(deps, space, exportId, format, scope, null, combined, contentType)];
  }

  const ordered = [...captured].sort((a, b) => (a.dayNumber ?? 0) - (b.dayNumber ?? 0));
  const artifacts: ExportArtifact[] = [];
  for (const item of ordered) {
    artifacts.push(
      await putOne(deps, space, exportId, format, scope, item.dayNumber, item.bytes, contentType),
    );
  }

  if (format === 'PNG' && scope === 'ALL_DAYS') {
    const archive = buildDailyPngZip(ordered);
    artifacts.push(
      await putOne(deps, space, exportId, 'ZIP', scope, null, archive, 'application/zip'),
    );
  }
  return artifacts;
}

async function putOne(
  deps: RunExportDeps,
  space: ContentSpace,
  exportId: string,
  format: ExportArtifactFormat,
  scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN',
  dayNumber: number | null,
  bytes: Uint8Array,
  contentType: string,
): Promise<ExportArtifact> {
  const key = exportObjectKeyFor(space, exportId, exportFileName(format, scope, dayNumber));
  await deps.storage.put({ key, body: bytes, contentType });

  /*
   * 上传后立刻签一次 URL 并落库。GET 端点会**再签一次**（13.6 的重签名），
   * 因此这里的 URL 只是「刚导出完就能用」的便利值 ——
   * 真正长期有效的东西是 `storage_key`。
   */
  const signed = await deps.storage.presign(key, EXPORT_URL_TTL_SECONDS);

  return ExportArtifactSchema.parse({
    format,
    day_number: dayNumber,
    url: signed.url,
    byte_size: bytes.byteLength,
    expires_at: signed.expiresAt.toISOString(),
    storage_key: key,
  });
}
