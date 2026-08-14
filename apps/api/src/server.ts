import Fastify from 'fastify';
import { metricsContentType, metricsText } from '@tps/observability';
import type { GracefulShutdown, Logger, ServiceConfig } from '@tps/shared';

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
}

/**
 * 返回类型交由推导：传入具体的 pino Logger 后 Fastify 会把实例泛型
 * 具体化为该 Logger 类型，与 `FastifyInstance` 的默认 `FastifyBaseLogger`
 * 不兼容（pino 的 BaseLogger 要求 msgPrefix）。显式标注只能靠把四个泛型
 * 参数全部写出来才成立，得不偿失。
 */
export function buildServer(deps: ServerDeps) {
  const { config, logger, shutdown, checkDependencies } = deps;

  const app = Fastify({
    loggerInstance: logger,
    // 不暴露服务器指纹
    disableRequestLogging: false,
    trustProxy: true,
    // 请求体上限：TravelRequestUI 很小，1MB 足够且能挡住误发的大载荷
    bodyLimit: 1_048_576,
  });

  /**
   * 存活探针：进程还在就返回 200。
   * 排空期间仍返回 200 —— 否则 K8s 会在优雅停机中途 SIGKILL 掉本实例。
   */
  app.get('/healthz', () => ({
    status: 'live',
    service: config.serviceName,
  }));

  /**
   * 就绪探针：排空中或依赖不可用时返回 503，负载均衡据此摘除实例。
   * 这是优雅停机能真正"优雅"的前提（设计稿 22.3.3）。
   */
  app.get('/readyz', async (_request, reply) => {
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
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metricsContentType);
    return reply.send(await metricsText());
  });

  return app;
}
