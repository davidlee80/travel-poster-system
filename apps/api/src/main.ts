import { GracefulShutdown, createLogger, loadServiceConfig, nodeEnv } from '@tps/shared';
import { registerDefaultMetrics } from '@tps/observability';
import { buildServer } from './server.js';

const SERVICE_NAME = 'tps-api';

async function main(): Promise<void> {
  const config = loadServiceConfig(SERVICE_NAME, 3001);
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.logLevel,
    pretty: nodeEnv() === 'development',
  });

  registerDefaultMetrics(SERVICE_NAME);

  const shutdown = new GracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  }).listen();

  const app = buildServer({ config, logger, shutdown });

  // 注册顺序即依赖顺序：HTTP 服务后注册 → 关闭时先停，
  // 保证连接池等基础设施在还有请求在处理时不被断开（见 GracefulShutdown 文档）
  shutdown.register('http-server', async () => {
    await app.close();
  });

  // 0.0.0.0 而非 localhost：容器内必须监听所有接口才能被外部访问
  await app.listen({ host: '0.0.0.0', port: config.port });

  logger.info(
    {
      port: config.port,
      node_env: config.nodeEnv,
      node_version: process.versions.node,
      tz: process.env['TZ'] ?? '(未设置)',
    },
    'API 已启动',
  );
}

main().catch((err: unknown) => {
  // 启动失败时 logger 可能还没建好，直接写 stderr
  process.stderr.write(`API 启动失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
