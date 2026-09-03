import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { metricsContentType, metricsText } from '@tps/observability';
import { optionalInt, type GracefulShutdown, type Logger, type ServiceConfig } from '@tps/shared';
import { buildErrorBody } from './errors/codes.js';
import { registerAuthRoutes, type AuthRoutesDeps } from './routes/auth.js';
import {
  registerInternalAssetRoutes,
  type InternalAssetRoutesDeps,
} from './routes/internal-assets.js';
import {
  registerInternalPresentationRoutes,
  type InternalPresentationRoutesDeps,
} from './routes/internal-presentations.js';
import { registerCreditRoutes, type CreditRoutesDeps } from './routes/credits.js';
import { registerExportRoutes, type ExportRoutesDeps } from './routes/exports.js';
import { registerTravelPlanRoutes, type TravelPlanRoutesDeps } from './routes/travel-plans.js';
import {
  registerPlannerConfigRoutes,
  type PlannerConfigRoutesDeps,
} from './routes/planner-config.js';

/**
 * API 服务（P0 骨架）。
 *
 * P0 只提供探针与 /metrics。业务端点按实施计划推进：
 *   P1  身份与账号（13.9）
 *   P2  生成、查询计划、任务状态、计划列表（13.1–13.4、13.9.5）
 *   P4  导出（13.5、13.6）
 */

export interface ServerDeps {
  readonly config: ServiceConfig;
  readonly logger: Logger;
  readonly shutdown: GracefulShutdown;
  /** 依赖就绪检查。P0 恒为 true；P1 起接入数据库与 Redis。 */
  readonly checkDependencies?: () => Promise<{ ok: boolean; detail: Record<string, boolean> }>;
  /** 身份与账号端点（13.9）。未提供时不注册这些路由（便于探针的独立测试）。 */
  readonly auth?: AuthRoutesDeps;
  /** 计划端点（13.1～13.3、13.9.5）。同上，未提供时不注册。 */
  readonly travelPlans?: TravelPlanRoutesDeps;
  /**
   * 导出端点（13.5、13.6）。未提供时不注册。
   *
   * 与 `travelPlans` 分开是因为它多两项依赖（导出队列与对象存储的预签名），
   * 而只跑「读计划」的部署（比如一个只读副本）不需要它们。
   */
  readonly exports?: ExportRoutesDeps;
  /**
   * 素材服务内部端点（14.1、14.2）。
   *
   * 未配置共享密钥时不注册 —— 这些端点做 CPU 与数据库工作，
   * 挂在公网服务上必须有认证（见 routes/internal-assets.ts）。
   */
  readonly internalAssets?: InternalAssetRoutesDeps;
  /**
   * 渲染路由取展示数据的内部端点（17.1）。
   *
   * 与 `internalAssets` 分开：前者是素材服务的契约（14.x），
   * 后者是渲染链路的取数入口。两者共用同一把共享密钥，
   * 但装配条件不同 —— 只跑渲染的部署不需要素材端点。
   */
  readonly internalPresentations?: InternalPresentationRoutesDeps;
  readonly plannerConfig?: PlannerConfigRoutesDeps;
  /**
   * CR 钱包端点（C-3）。未提供时不注册。
   *
   * 装配条件是 `CREDIT_BILLING_ENABLED` + 库已迁到 0013 —— 钱包表不存在时
   * 这三个端点每次调用都会 500，而注册它们等于对外承诺它们可用。
   */
  readonly credits?: CreditRoutesDeps;
  /**
   * 传输层每-IP 限流。缺省取 `RATE_LIMIT_*` 环境变量（见 `loadRateLimitConfig`）。
   *
   * `max: 0` 关闭限流 —— 给需要发大量请求的用例一个出口，
   * 而不是让它们去猜阈值够不够大。
   */
  readonly rateLimit?: RateLimitConfig;
}

export interface RateLimitConfig {
  /** 窗口内允许的请求数。`0` = 不注册限流 */
  readonly max: number;
  readonly timeWindowMs: number;
}

/**
 * 限流默认值：每 IP 每分钟 300 次。
 *
 * ## 为何比业务配额高两个数量级
 *
 * 21.4 的生成配额是每分钟 1～3 次，而这一层**不是拿来替代它的**。
 * 一个正常使用的会话除了生成还要轮询任务状态（每 1～2 秒一次，
 * 持续到一分钟）、读展示数据、拉历史列表 —— 把阈值定得接近业务配额
 * 会把轮询打成 429，而那是生成体验的主路径。
 *
 * 300/分钟 ≈ 5 rps，远高于任何真实使用者，但足以让单一源的洪水
 * 在压垮数据库之前就被挤在入口 —— 而那正是它存在的全部理由。
 *
 * ## 它是每副本的，不是全局的
 *
 * 用内存计数而不是 Redis：后者让阈值全局统一，但也把一条 Redis 往返
 * 加进了**每一个**请求，包括洪水里的那些 —— 于是限流器自己成了
 * 放大器。代价是实际上限为 `max × 副本数`，这在防洪水的量级上无关紧要。
 */
export const RATE_LIMIT_MAX = 300;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export function loadRateLimitConfig(): RateLimitConfig {
  return {
    max: optionalInt('RATE_LIMIT_MAX', RATE_LIMIT_MAX),
    timeWindowMs: optionalInt('RATE_LIMIT_WINDOW_MS', RATE_LIMIT_WINDOW_MS),
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const {
    config,
    logger,
    shutdown,
    checkDependencies,
    auth,
    travelPlans,
    exports: exportRoutes,
    internalAssets,
    internalPresentations,
    plannerConfig,
    credits,
    rateLimit: rateLimitConfig = loadRateLimitConfig(),
  } = deps;

  /*
   * 显式标注为 FastifyBaseLogger，而不是直接把 pino 的 Logger 传进 Fastify。
   *
   * Fastify 会从 `loggerInstance` **推断实例泛型**：传具体的 pino 类型会让
   * 实例变成 `FastifyInstance<..., pino.Logger>`，与默认的 `FastifyInstance`
   * 不兼容（pino 的 BaseLogger 要求 `msgPrefix`），进而导致任何接收
   * `FastifyInstance` 的函数（如 registerAuthRoutes）都无法接受它。
   *
   * 用类型标注而不是 `as` 断言：两者对推断等效，但 `no-unnecessary-type-assertion`
   * 会把这种「用于控制推断」的断言判为多余并自动删掉 —— 删掉后编译又会失败。
   */
  const fastifyLogger: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance: fastifyLogger,
    // 不暴露服务器指纹
    disableRequestLogging: false,
    trustProxy: true,
    // 请求体上限：TravelRequestUI 很小，1MB 足够且能挡住误发的大载荷
    bodyLimit: 1_048_576,

    /*
     * 21.3 要求每条日志携带 `request_id`（TP-5-02）。
     *
     * Fastify 默认把它记成 `reqId`，字段名与 21.3 的清单不一致 ——
     * 而排查时用的是 `grep request_id`，一个不同的名字等于这个字段不存在。
     */
    requestIdLogLabel: 'request_id',

    /*
     * 透传网关/前端给的 `X-Request-Id`。
     *
     * 这是跨服务追一次请求的常规手段，而且**它与 trace_id 不重复**：
     * trace 由 OTel 装配后才有（TP-5-03），且采样率 < 100% 时会缺；
     * request_id 恒存在，且用户能从错误响应里读到并报给客服。
     */
    requestIdHeader: 'x-request-id',

    /*
     * 没有请求头时生成 UUID，而不是用 Fastify 默认的 `req-1` 递增序号。
     *
     * 递增序号在多副本下必然重复：三个 api 实例各自从 req-1 开始，
     * 日志里 `request_id=req-42` 会同时命中三条毫不相关的请求 ——
     * 而这个字段的全部用途就是唯一标识一次请求。
     */
    genReqId: () => randomUUID(),
  });

  /*
   * 把 request_id 回写到响应头（TP-5-02）。
   *
   * Fastify 只把它记进日志，不放进响应 —— 而它对用户的价值恰恰在响应里：
   * 出错时用户能把这个 ID 报给客服，客服据此在日志里定位到那一条请求。
   * 没有它的话，排查一次用户报障要靠「大概几点、什么目的地」去猜。
   *
   * 用 `onRequest` 而不是 `onSend`：错误路径（包括 Fastify 自己产生的
   * 400/404/500）也要带上它，而 `onSend` 在某些早期错误里不会执行。
   */
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  /*
   * ── 传输层每-IP 限流 ──
   *
   * 它填的是 `QuotaGuard` 接不到的那一段：业务配额在**身份解析之后**
   * 判定，而身份解析本身就要查 Redis 与数据库 —— 因此一个不带有效
   * Cookie 的洪水根本走不到配额那一层，却已经把依赖打满了。
   *
   * 注册在 request_id 钩子**之后**：Fastify 按注册顺序跑 onRequest，
   * 而插件加钩子发生在 `ready()`（更晚）。于是 429 响应也带
   * `x-request-id` —— 用户报障时那个 ID 是唯一能定位到请求的线索，
   * 而被限流拦住的请求恰好是最可能被报障的那批。
   */
  if (rateLimitConfig.max > 0) {
    void app.register(rateLimit, {
      global: true,
      max: rateLimitConfig.max,
      timeWindow: rateLimitConfig.timeWindowMs,
      /*
       * `trustProxy: true` 已经让 `request.ip` 是真实客户端 IP（经
       * X-Forwarded-For）。显式写出这个键而不靠默认：默认也是
       * `request.ip`，但「按什么分桶」是限流器最要紧的一个判断 ——
       * 它退化成按网关 IP 分桶时，全站共用一个配额。
       */
      keyGenerator: (request) => request.ip,
      /*
       * 13.0 的错误信封。
       *
       * 插件把这个返回值 **throw** 出去（见其 index.js），因此必须是一个
       * 带 `statusCode` 的 Error —— 返回纯对象的表现是 500。
       *
       * 而 Fastify 的默认错误序列化只输出 `{statusCode, code, error, message}`，
       * 不带我们的信封。而前端（`api-client.ts` L128-134）读不到
       * `error.code` 时会回退到 `SYS_INTERNAL_ERROR` + 「服务暂时不可用」——
       * 把一次限流告诉用户成了服务器故障，且没有任何「慢一点」的提示。
       *
       * 因此把信封挂在 `tpsErrorBody` 上，由下面的错误处理器原样发出。
       */
      errorResponseBuilder: (request, context) => {
        const error = new Error('rate limit exceeded') as Error & {
          statusCode: number;
          tpsErrorBody: unknown;
        };
        error.statusCode = context.statusCode;
        error.tpsErrorBody = buildErrorBody('SYS_RATE_LIMITED', {
          requestId: request.id,
          traceId: 'unavailable',
        });
        return error;
      },
      /* 带上标准的 `RateLimit-*` 头，让客户端能自己退避而不是硬撞 */
      enableDraftSpec: true,
    });

    /*
     * 只为带了 `tpsErrorBody` 的错误接手，其余全部原样交回 Fastify。
     *
     * 窄到只看一个自定义属性，是为了不动全站的错误形态 ——
     * 13.7 的业务错误都是各路由自己 `reply.send` 的，根本不走错误处理器；
     * 而 Fastify 自己产生的 400（畸形 JSON）/404 必须保持原样，
     * 否则会改变一批与限流无关的契约。
     */
    app.setErrorHandler((error, _request, reply) => {
      const marked = error as Error & { statusCode?: number; tpsErrorBody?: unknown };
      if (marked.tpsErrorBody !== undefined) {
        return reply.code(marked.statusCode ?? 429).send(marked.tpsErrorBody);
      }
      return reply.send(error);
    });
  }

  /*
   * 容忍 `content-type: application/json` + 空请求体。
   *
   * Fastify 默认对这种请求回 400 `FST_ERR_CTP_EMPTY_JSON_BODY`。而
   * `/auth/logout` 这类端点**不需要请求体** —— 一个统一给所有请求加
   * JSON content-type 的客户端（我们自己的 api-client 就是这么写的，
   * 见 `apps/web/src/lib/api-client.ts`）在这里必然撞墙。
   *
   * 症状极其隐蔽：登出请求拿到 400，而前端不看登出的返回值（它接着去重新
   * 取身份，而身份还在），于是**「退出登录」按钮点了没反应**，没有任何报错。
   * 这个 bug 从 TP-1-40 起一直存在，而端点层测试测不到它 ——
   * `app.inject` 不传 payload 时根本不发 content-type，走不到这个解析器。
   *
   * 这一层放在服务端而不是只修客户端：13.x 明确邀请第三方替换前端呈现层，
   * 而「给所有 POST 加 JSON content-type」是最常见的写法之一。
   *
   * 空体解析成 `undefined`，于是需要请求体的端点走各自的 Zod 校验，
   * 返回 13.7 形态的 `REQ_SCHEMA_INVALID` —— 比 Fastify 那个自带形态
   * （不符合 13.0 的错误信封）更贴合契约。
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        /*
         * 畸形 JSON 仍然是 400，与内置解析器一致。
         *
         * `statusCode` 必须自己带上：Fastify 只看错误对象上的这个字段，
         * 而 `JSON.parse` 抛的 SyntaxError 没有它 —— 少了这两行，
         * 一个手抖打错的请求体会变成 500，被当作服务端故障告警。
         */
        const error = new Error('请求体不是合法的 JSON') as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  /**
   * 存活探针：进程还在就返回 200。
   * 排空期间仍返回 200 —— 否则 K8s 会在优雅停机中途 SIGKILL 掉本实例。
   */
  app.get('/healthz', { config: { rateLimit: false } }, () => ({
    status: 'live',
    service: config.serviceName,
  }));

  /**
   * 就绪探针：排空中或依赖不可用时返回 503，负载均衡据此摘除实例。
   * 这是优雅停机能真正"优雅"的前提（设计稿 22.3.3）。
   */
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    if (shutdown.isDraining) {
      return reply.code(503).send({
        status: 'draining',
        reason_code: 'SHUTTING_DOWN',
      });
    }

    const deps = checkDependencies ? await checkDependencies() : { ok: true, detail: {} };
    if (!deps.ok) {
      return reply.code(503).send({
        status: 'not_ready',
        reason_code: 'SYS_DEPENDENCY_UNAVAILABLE',
        detail: deps.detail,
      });
    }

    return reply.code(200).send({ status: 'ready', detail: deps.detail });
  });

  /** Prometheus 抓取端点（设计稿 21.3） */
  app.get('/metrics', { config: { rateLimit: false } }, async (_request, reply) => {
    reply.header('content-type', metricsContentType);
    return reply.send(await metricsText());
  });

  /*
   * 业务路由放在 `after()` 里注册。
   *
   * ## 不这么做限流会静默失效
   *
   * Fastify 在**声明路由的那一刻**就把当前作用域的 `onRequest` 钩子
   * 绑定到该路由上，而 `app.register()` 是**延迟**的（要到 `ready()`
   * 才加载）。因此直接写 `app.register(rateLimit); app.get(...)` 的话，
   * 路由声明时限流插件还没加钩子 —— 于是**一个路由都不受限流**，
   * 而插件看起来已经“注册成功”：无报错、有 `RateLimit-*` 头的路由一个也没有。
   *
   * `after()` 的回调在先前排队的插件加载完之后执行，这时钩子已在作用域上。
   *
   * 探针与 `/metrics` 留在外面：它们本就豁免（`rateLimit: false`），
   * 而放在外面能保证即使插件加载失败，存活探针仍然可用。
   */
  app.after(() => {
    if (auth !== undefined) {
      registerAuthRoutes(app, auth);
    }
    if (travelPlans !== undefined) {
      registerTravelPlanRoutes(app, travelPlans);
    }
    if (exportRoutes !== undefined) {
      registerExportRoutes(app, exportRoutes);
    }
    if (internalAssets !== undefined) {
      registerInternalAssetRoutes(app, internalAssets);
    }
    if (internalPresentations !== undefined) {
      registerInternalPresentationRoutes(app, internalPresentations);
    }
    if (plannerConfig !== undefined) {
      registerPlannerConfigRoutes(app, plannerConfig);
    }
    if (credits !== undefined) {
      registerCreditRoutes(app, credits);
    }
  });

  return app;
}
