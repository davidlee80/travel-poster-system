import { createServer, type Server } from 'node:http';
import { GracefulShutdown } from './shutdown.js';
import { createLogger, type Logger } from './logger.js';
import { loadServiceConfig, nodeEnv, type ServiceConfig } from './config.js';

/**
 * Worker 进程运行时骨架（TP-0-08）。
 *
 * 三个 Worker（generation / render / retention）的进程管理是同构的：
 * 起探针 HTTP 服务、注册指标、监听 SIGTERM、排空时停止取新任务。
 * 抽出来一份，避免三处各写一遍停机逻辑 —— 停机逻辑写错的代价是任务悬挂
 * （设计稿 22.3.3、验收门禁 #34），不适合复制粘贴。
 *
 * 探针 HTTP 服务用 node:http 而非 Fastify：Worker 只需要两个固定路由，
 * 引入完整 Web 框架只是增加镜像体积与攻击面。
 */

export interface WorkerHandle {
  readonly logger: Logger;
  readonly config: ServiceConfig;
  readonly shutdown: GracefulShutdown;
  /** 排空中应停止领取新任务 */
  readonly isDraining: () => boolean;
}

export interface WorkerDefinition {
  readonly serviceName: string;
  readonly probePort: number;
  /**
   * 启动 Worker 主体。返回的清理函数会注册为关闭钩子，
   * 应当「停止领取新任务 → 等待在途任务完成」。
   */
  readonly start: (handle: WorkerHandle) => Promise<() => Promise<void>>;
  /** 依赖就绪检查；缺省视为就绪 */
  readonly checkDependencies?: () => Promise<{ ok: boolean; detail: Record<string, boolean> }>;
  /** 指标文本提供者。由调用方注入以避免 shared 依赖 observability（会形成循环）。 */
  readonly metrics?: () => Promise<{ contentType: string; body: string }>;
  /**
   * Trace 装配（TP-5-03）。返回 null 表示未配置端点，全程 no-op。
   *
   * 与 `metrics` 同一处理：由调用方注入而不是本包直接 import
   * `@tps/observability` —— 后者的 devDependencies 里有 `@tps/shared`，
   * 直接依赖会形成循环。
   *
   * 在 `start` **之前**调用：instrumentation 挂钩的是模块调用，
   * 而 `start` 里就会建数据库连接池与 Redis 连接。
   */
  readonly tracing?: () => { shutdown: () => Promise<void> } | null;
}

function startProbeServer(definition: WorkerDefinition, handle: WorkerHandle): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/healthz')) {
      // 排空期间仍返回 200，避免被 SIGKILL 打断优雅停机
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'live', service: definition.serviceName }));
      return;
    }

    if (url.startsWith('/readyz')) {
      void (async () => {
        if (handle.isDraining()) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'draining', reason_code: 'SHUTTING_DOWN' }));
          return;
        }
        const deps = definition.checkDependencies
          ? await definition.checkDependencies()
          : { ok: true, detail: {} };
        res.writeHead(deps.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            deps.ok
              ? { status: 'ready', detail: deps.detail }
              : {
                  status: 'not_ready',
                  reason_code: 'SYS_DEPENDENCY_UNAVAILABLE',
                  detail: deps.detail,
                },
          ),
        );
      })();
      return;
    }

    if (url.startsWith('/metrics') && definition.metrics) {
      void (async () => {
        const { contentType, body } = await definition.metrics!();
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      })();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });

  server.listen(definition.probePort, '0.0.0.0');
  return server;
}

export async function runWorker(definition: WorkerDefinition): Promise<void> {
  // 最先装配 trace，最后关闭它（hook 逆序执行）——
  // 不 flush 会丢掉停机前那一批 span，而滚动更新期间的问题就出在那里
  const tracing = definition.tracing?.() ?? null;

  const config = loadServiceConfig(definition.serviceName, definition.probePort);
  const logger = createLogger({
    service: definition.serviceName,
    level: config.logLevel,
    pretty: nodeEnv() === 'development',
  });

  const shutdown = new GracefulShutdown({ logger, timeoutMs: config.shutdownTimeoutMs }).listen();

  if (tracing !== null) {
    shutdown.register('tracing', () => tracing.shutdown());
  }

  const handle: WorkerHandle = {
    logger,
    config,
    shutdown,
    isDraining: () => shutdown.isDraining,
  };

  const probe = startProbeServer(definition, handle);
  shutdown.register('probe-server', async () => {
    await new Promise<void>((resolve, reject) => {
      probe.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Worker 主体后注册 → 关闭时先停：先停止领任务，再关探针与连接
  const stop = await definition.start(handle);
  shutdown.register('worker-body', stop);

  logger.info(
    {
      probe_port: definition.probePort,
      node_env: config.nodeEnv,
      node_version: process.versions.node,
      tz: process.env['TZ'] ?? '(未设置)',
    },
    `${definition.serviceName} 已启动`,
  );
}
