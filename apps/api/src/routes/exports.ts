import { randomUUID } from 'node:crypto';

import {
  UniqueViolationError,
  type ExportDownloadRow,
  type ExportRow,
  type ExportsRepository,
  type PresentationsRepository,
  type TravelPlansRepository,
} from '@tps/db';
import { captureTraceContext, EXPORT_QUEUE_NAME, type ExportQueue } from '@tps/queue';
import {
  CreateExportRequestSchema,
  EXPORT_PROGRESS,
  EXPORT_URL_TTL_SECONDS,
  ExportArtifactSchema,
  type ExportArtifact,
  type ExportDetail,
  type ExportStatus,
} from '@tps/schemas';
import {
  computeExportIdempotencyKey,
  decideFeature,
  type FeatureFlags,
  type QuotaGuard,
} from '@tps/shared';
import type { ExportStorage } from '@tps/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  buildErrorBody,
  errorDefinition,
  messageForCode,
  type ErrorCode,
} from '../errors/codes.js';
import { ALL_FEATURES_ON, featureGateTotal } from '../feature-gate.js';
import {
  decideAdmission,
  loadQueueAdmissionMaxDepth,
  queueAdmissionRejectedTotal,
  type QueueBacklog,
} from '../queue-depth.js';
import { recordCreditGate } from '../credits/metrics.js';
import type { CreditsService } from '../credits/service.js';
import { resolveIdentity, type IdentityContextDeps } from './identity-context.js';
import { buildDownloadFileName } from '../download-file-name.js';

/**
 * 导出端点（TP-4-12/13/16，设计稿 13.5、13.6）。
 *
 * ```text
 * 13.5  POST /api/v1/travel-plans/{plan_id}/exports
 * 13.6  GET  /api/v1/exports/{export_id}
 * ```
 *
 * ## 幂等命中不扣配额（21.4）
 *
 * 与 13.1 同一条：顺序必须是「先查既有 → 再扣配额」。反过来的话，用户
 * 刷新页面重试会命中幂等却已经被扣了一次导出额度 —— 而匿名用户每个计划
 * 只有 3 次。
 *
 * ## 重签名不重渲染（13.6）
 *
 * 「过期后重新调用本端点获取新签名，不重新渲染」。落地方式是把
 * `storage_key` 一起存进 `exports.files`，GET 时**每次都重新签名** ——
 * 而不是「判断过期了才重签」。理由是判断需要比较时钟，而客户端与服务端的
 * 时钟偏差会让「刚好没过期」的 URL 在客户端手里已经失效；每次重签的成本
 * 是一次本地 HMAC 计算，没有网络往返。
 */

export interface ExportRoutesDeps extends IdentityContextDeps {
  readonly plans: TravelPlansRepository;
  readonly exports: ExportsRepository;
  /**
   * 只用 `findPresentationByVersion`，为了校验请求里的样式套件真有展示数据
   * （R-85）。收窄到单个方法而不收整个仓储：导出路由不应当能写
   * 展示数据，而类型上限住比写注释可靠。
   */
  readonly presentations: Pick<PresentationsRepository, 'findPresentationByVersion'>;
  readonly quota: QuotaGuard;
  readonly queue: ExportQueue;
  /**
   * 只要 `presign`，不要 `put`。
   *
   * 这不是洁癖：预签名只是一次本地 HMAC 计算，因此 api 进程的 S3 凭据
   * **只需要导出桶的 GetObject 权限**。类型上收窄到 `presign` 是为了让
   * 「api 不应写对象存储」这件事在编译期成立 —— 而不是靠部署时记得配一个
   * 只读密钥（R-32 的同一条顾虑：面向公网的进程不该拿到写凭据）。
   */
  readonly storage: Pick<ExportStorage, 'presign'>;
  /** 灰度开关（TP-5-10）。缺省视为全开，理由见 feature-gate.ts */
  readonly featureFlags?: FeatureFlags;
  /** CR 计费（C-3）。未提供时导出不计费，理由见 travel-plans.ts 的同名字段 */
  readonly credits?: CreditsService;
  /**
   * 背压准入。看的是**导出队列**的深度，与生成队列分开 ——
   * 两个队列的消费者是不同进程（generation-worker / render-worker），
   * 共用一个阈值会让生成积压误伤导出，而导出此时可能完全空闲。
   */
  readonly backlog?: QueueBacklog;
  /** 准入阈值。缺省取 `QUEUE_ADMISSION_MAX_DEPTH` */
  readonly admissionMaxDepth?: number;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extra?: {
    readonly field?: string;
    readonly retryAfterSeconds?: number | null;
    readonly details?: Readonly<Record<string, number>>;
  },
): FastifyReply {
  const definition = errorDefinition(code);
  if (extra?.retryAfterSeconds != null) {
    reply.header('retry-after', String(extra.retryAfterSeconds));
  }
  return reply.code(definition.httpStatus).send(
    buildErrorBody(code, {
      requestId: request.id,
      traceId: 'unavailable',
      ...(extra?.field === undefined ? {} : { field: extra.field }),
      ...(extra?.details === undefined ? {} : { details: extra.details }),
    }),
  );
}

/** `exports.files` 里存的是 `ExportArtifact[]`（含 storage_key） */
function parseArtifacts(files: unknown): readonly ExportArtifact[] {
  const parsed = z.array(ExportArtifactSchema).safeParse(files);
  /*
   * 解析失败时返回空数组而不是抛错：`files` 是我们自己写进去的，
   * 但旧行可能是旧契约产出的（`exports` 行按 15.1 保留 90 天）。
   * 抛错会让「查一个三个月前的导出」变成 500，而空数组 + 状态仍然可读
   * 至少让用户看到「这次导出已经过期」。
   */
  return parsed.success ? parsed.data : [];
}

/** 每次都重新签名（见文件头）。产物为空时直接返回空数组 */
async function signedFiles(
  storage: Pick<ExportStorage, 'presign'>,
  artifacts: readonly ExportArtifact[],
  row: ExportDownloadRow,
): Promise<ExportDetail['files']> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      const fileName = buildDownloadFileName(
        {
          destinationName: row.destinationName,
          startDate: row.startDate,
          totalDays: row.totalDays,
          versionNumber: row.versionNumber,
          scope: row.scope,
        },
        { format: artifact.format, dayNumber: artifact.day_number },
      );
      const signed = await storage.presign(artifact.storage_key, EXPORT_URL_TTL_SECONDS, {
        downloadName: fileName,
      });
      return {
        format: artifact.format,
        day_number: artifact.day_number,
        file_name: fileName,
        url: signed.url,
        byte_size: artifact.byte_size,
        expires_at: signed.expiresAt.toISOString(),
      };
    }),
  );
}

async function toDetail(
  storage: Pick<ExportStorage, 'presign'>,
  row: ExportDownloadRow,
): Promise<ExportDetail> {
  const status = row.status as ExportStatus;
  return {
    export_id: row.exportId,
    plan_version_id: row.planVersionId,
    template_id: row.templateId,
    status,
    format: row.format,
    scope: row.scope,
    day_numbers: row.dayNumbers === null ? null : [...row.dayNumbers],
    // 13.6：progress 查表而不是估算（与 16.2 同一处理）
    progress: EXPORT_PROGRESS[status] ?? row.progress,
    files: await signedFiles(storage, parseArtifacts(row.files), row),
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    error:
      row.errorCode === null
        ? null
        : {
            code: row.errorCode,
            // 旧版本写入的码可能已经改名，兜底文案好过显示「undefined」
            message: messageForCode(row.errorCode) ?? '导出未完成，请重试。',
          },
  };
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRoutesDeps): void {
  const { plans, exports: repository, quota, queue, storage } = deps;

  /** 13.5 创建导出任务 */
  app.post<{ Params: { plan_id: string } }>(
    '/api/v1/travel-plans/:plan_id/exports',
    async (request, reply) => {
      /*
       * 背压准入（导出队列）。放在最前面，与生成端点同一理由；
       * 差别是导出端点不现场建号，因此这里省下的是 Chromium 而不是用户行。
       */
      if (deps.backlog !== undefined) {
        const admission = decideAdmission(
          deps.backlog,
          EXPORT_QUEUE_NAME,
          deps.admissionMaxDepth ?? loadQueueAdmissionMaxDepth(),
        );
        if (!admission.admit) {
          queueAdmissionRejectedTotal.inc({ queue: EXPORT_QUEUE_NAME });
          request.log.warn(
            { error_code: 'SYS_QUEUE_SATURATED', queue_depth: admission.depth },
            '导出队列积压达到准入上限，拒绝新导出请求',
          );
          return fail(request, reply, 'SYS_QUEUE_SATURATED', {
            retryAfterSeconds: admission.retryAfterSeconds,
          });
        }
      }

      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      /*
       * 灰度开关（TP-5-10）。导出与生成分开关：两者的成本量级差三个数量级
       * （导出是几秒 Chromium CPU，生成是模型调用的钱），因此紧急降成本时
       * 先关生成、保留导出 —— 用户至少还能把已有的计划导出带走。
       *
       * 导出**不做百分比放量**：它没有新旧两套实现可以对比，
       * 开关的用途只是紧急止血。
       */
      const gate = decideFeature(
        deps.featureFlags ?? ALL_FEATURES_ON,
        'export',
        resolved.identity.userId,
      );
      if (!gate.allowed) {
        request.log.info({ reason_code: gate.reason ?? 'disabled' }, '导出功能当前不可用');
        featureGateTotal.inc({ event: 'export', reason_code: gate.reason ?? 'disabled' });
        return fail(request, reply, 'SYS_FEATURE_DISABLED');
      }

      const parsed = CreateExportRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return fail(request, reply, 'REQ_SCHEMA_INVALID', {
          field: parsed.error.issues[0]?.path.join('.') ?? 'body',
        });
      }
      const body = parsed.data;

      /*
       * 归属校验借 13.3 的读路径完成：它已经带 `user_id` 谓词，并且会把
       * 当前版本是 REJECTED 的计划一并挡掉（验收标准 15）。
       * 少了这一步，用户能导出一份未通过校验的草稿。
       */
      const plan = await plans.findPlanForUser(request.params.plan_id, resolved.identity.userId);
      if (plan === null) return fail(request, reply, 'PLAN_NOT_FOUND');

      /*
       * 13.7 `EXPORT_PLAN_VERSION_MISMATCH`：用户在页面上点导出，而此刻计划
       * 刚好被重新生成。他要的是屏幕上那一版 —— 而那一版已经不是当前版本了。
       * 直接导出当前版本会给他一份内容与他看到的不同的 PDF。
       */
      const requestedVersion = body.plan_version_id ?? plan.planVersionId;
      if (requestedVersion !== plan.planVersionId) {
        return fail(request, reply, 'EXPORT_PLAN_VERSION_MISMATCH');
      }

      /*
       * 样式套件：校验 + 缺省解析，一次查询完成（R-85）。
       *
       * **传了** → 按它过滤。查不到就是那个套件没有展示数据，直接拒。
       * `exports.template_id` 从前只是存下来而从不被消费，因此也从未被校验；
       * 不校验的后果是任务建成功、扣了配额、进了队列，然后渲染时读不到
       * presentation 而失败 —— 而那个失败发生在**异步阶段**，用户已经等了一分钟。
       *
       * **没传** → 不过滤，拿回来的行就是这份计划自己的套件。
       * 这比在 schema 里填一个全局默认值强：全局默认在计划用了别的套件时
       * 会被上面那条拒掉，而客户端没提过模板。
       *
       * 用 FULL_PLAN 探一次就够：编排是 N+1 页一事务写入（savePresentations），
       * 全览页存在则日页必然存在。逆向不成立，所以不能拿某一天来探。
       */
      const presentation = await deps.presentations.findPresentationByVersion({
        planVersionId: requestedVersion,
        pageType: 'FULL_PLAN',
        ...(body.template_id === undefined ? {} : { templateId: body.template_id }),
      });
      if (presentation === null) {
        return fail(request, reply, 'EXPORT_TEMPLATE_UNAVAILABLE');
      }
      /*
       * 下游一律用**解析后**的值而不是 `body.template_id`。
       *
       * 幂等键尤其如此：同一份计划、一个客户端省略了 template_id、
       * 另一个显式传了同一个值 —— 两者必须算出同一个键，否则会起两个
       * 内容完全相同的导出任务，扣两次配额、渲两遍。
       */
      const templateId = presentation.templateId;

      const dayNumbers = body.day_numbers ?? null;
      const idempotencyKey = computeExportIdempotencyKey({
        planVersionId: requestedVersion,
        format: body.format,
        scope: body.scope,
        dayNumbers,
        templateId,
      });

      // ── 幂等命中：直接返回原 export_id，不扣配额、不重复渲染（13.5） ──
      const existing = await repository.findByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        return reply.code(200).send({ export_id: existing.exportId, status: existing.status });
      }

      // ── 21.4：每计划导出次数 ──
      const decision = await quota.consumeExport({
        planId: request.params.plan_id,
        userType: resolved.identity.userType,
      });
      if (!decision.allowed) {
        return fail(request, reply, 'AUTH_QUOTA_EXCEEDED', {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }

      const exportId = randomUUID();

      /*
       * ── 建行 ──
       *
       * 在扣费**之前**，与早期实现相反。当时把扣费放在前面的理由是
       * 「余额不足时会留下一行永远不会渲染的导出任务，而它占着幂等键」，
       * 而迁移 0018 之后那个理由不再成立：把行置为 `FAILED` 就能腾出键位。
       *
       * 而这个顺序修好了一个靠原顺序无法修的问题：扣费幂等键现在按
       * `export_id`（每次尝试都是新的），并发去重因此不能再靠它 ——
       * 必须靠**先建行**：唯一索引定胜负，输的一方拿到
       * `UniqueViolationError` 时还一分钱都没扣。
       */
      let created: ExportRow;
      try {
        created = await repository.create({
          exportId,
          userId: resolved.identity.userId,
          planId: request.params.plan_id,
          planVersionId: requestedVersion,
          templateId,
          format: body.format,
          scope: body.scope,
          dayNumbers,
          idempotencyKey,
        });
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        /*
         * 唯一索引兜住并发：两个请求同时走到这里，一个成功、一个冲突。
         * 冲突方回查既有任务并返回它 —— 与 13.8 的生成幂等同一手法。
         * 它没扣过钱，因此也无需退。
         */
        const raced = await repository.findByIdempotencyKey(idempotencyKey);
        if (raced === null) throw error;
        return reply.code(200).send({ export_id: raced.exportId, status: raced.status });
      }

      /**
       * 把刚建的行置为 `FAILED`。
       *
       * 经由迁移 0018 的部分唯一索引，这一步同时**腾出幂等键** ——
       * 于是用户拿同一组参数重试会得到一份全新的导出，而不是永远命中
       * 一行没人消费的残局。置 FAILED 而不是删行：`error_code` 是
       * 「这个用户的导出为何一直失败」的唯一证据。
       */
      const abandon = async (errorCode: ErrorCode, reason: string): Promise<void> => {
        await repository.finish({
          exportId: created.exportId,
          status: 'FAILED',
          files: [],
          errorCode,
          errorDetail: { reason },
        });
      };

      /*
       * ── CR 扣费（C-3）──
       *
       * 导出**不做预留/结算往返**：成本是几秒 Chromium CPU + 存储，
       * 量级比生成小三个数量级，且与内容无关 —— 定价固定，因此没有
       * 「估多估少」的问题，两阶段只是多两次写库。
       */
      let chargedCr = 0;
      if (deps.credits !== undefined) {
        const charged = await deps.credits.chargeExport({
          userId: resolved.identity.userId,
          exportId,
          format: body.format,
        });
        if (charged.kind === 'insufficient') {
          recordCreditGate('export', 'insufficient');
          /* 行已经建了，因此必须把它收掉，否则它占着键位 */
          await abandon('AUTH_INSUFFICIENT_CREDITS', 'INSUFFICIENT_CREDITS');
          return fail(request, reply, 'AUTH_INSUFFICIENT_CREDITS', {
            details: { required_cr: charged.requiredCr, balance_cr: charged.balanceCr },
          });
        }
        recordCreditGate('export', charged.kind === 'charged' ? 'allowed' : 'free');
        if (charged.kind === 'charged') chargedCr = charged.amountCr;
      }

      /**
       * 退回本次扣费。
       *
       * 前提是「钱已经扣了，而用户拿不到任何东西」。不退的表现是
       * 用户为一份不存在的导出付了钱，而他看到的只是一个 5xx，
       * 不会想到去查流水。
       *
       * 键是 `refund:export:<export_id>`，与 render-worker 的退款完全一致 ——
       * 同一笔不可能被退两次。
       */
      const refundCharge = async (): Promise<void> => {
        if (deps.credits === undefined || chargedCr === 0) return;
        await deps.credits.refundExport({
          userId: resolved.identity.userId,
          amountCr: chargedCr,
          exportId,
        });
      };

      const traceContext = captureTraceContext();
      /*
       * 入队失败必须自己收尾（TP-5-03 的理由同 13.1 的入队点）。
       *
       * 走到这一行时，钱已经扣了（chargeExport）、行已经建了（create）。
       * Redis 抖动让异常直接冒出去的后果不是「一次 500」而是**永久卡死**：
       * 那一行停在 QUEUED，而队列里没有消息，因此永远不会有人消费它；
       * 而 13.5 的幂等键不含 nonce，用户拿同一组参数重试只会一直命中它。
       *
       * 因此这里做两件事：退钱，并把行置为 `FAILED` —— 后者经由迁移 0018
       * 的部分唯一索引**腾出幂等键**，于是用户重试会得到一份全新的导出。
       * 置 FAILED 而不是删行：`error_code` 是「这个用户的导出为何一直失败」
       * 的唯一证据。
       */
      try {
        await queue.enqueue({
          exportId: created.exportId,
          ...(traceContext === undefined ? {} : { traceContext }),
        });
      } catch (error) {
        await refundCharge();
        await abandon('SYS_DEPENDENCY_UNAVAILABLE', 'ENQUEUE_FAILED');
        request.log.error(
          { export_id: created.exportId, error_code: 'SYS_DEPENDENCY_UNAVAILABLE' },
          `导出入队失败，已退款并释放幂等键：${String(error)}`,
        );
        return fail(request, reply, 'SYS_DEPENDENCY_UNAVAILABLE');
      }

      return reply.code(201).send({ export_id: created.exportId, status: created.status });
    },
  );

  /** 13.6 获取导出结果 */
  app.get<{ Params: { export_id: string } }>(
    '/api/v1/exports/:export_id',
    async (request, reply) => {
      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      const row = await repository.findForUser(request.params.export_id, resolved.identity.userId);
      // 他人的导出与不存在的导出返回同一个 404（13.0）
      if (row === null) return fail(request, reply, 'EXPORT_NOT_FOUND');

      return reply.code(200).send(await toDetail(storage, row));
    },
  );

  /** 结果页刷新后恢复该计划的导出任务，数量受每计划导出配额限制。 */
  app.get<{ Params: { plan_id: string } }>(
    '/api/v1/travel-plans/:plan_id/exports',
    async (request, reply) => {
      const resolved = await resolveIdentity(deps, request, reply, {
        allowAnonymousCreation: false,
      });
      if (resolved === null) return reply;

      const plan = await plans.findPlanForUser(request.params.plan_id, resolved.identity.userId);
      if (plan === null) return fail(request, reply, 'PLAN_NOT_FOUND');

      const rows = await repository.listForPlanForUser(
        request.params.plan_id,
        resolved.identity.userId,
      );
      return reply
        .code(200)
        .send({ items: await Promise.all(rows.map((row) => toDetail(storage, row))) });
    },
  );
}
