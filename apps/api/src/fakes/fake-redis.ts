import type { Redis } from 'ioredis';

/**
 * Fake Redis 实现。
 *
 * 用于测试：模拟 Redis 命令的延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`commandDelayMs` 模拟命令执行慢；
 * - **故障模拟**：`connectionError` 模拟连接失败，`commandError` 模拟命令执行失败；
 * - **命令编排**：`byCommand` 按命令名编排特定命令的行为。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/queue/src/redis.ts`）会：
 * 1. 建立 TCP 连接到 Redis；
 * 2. 执行命令并返回结果；
 * 3. 管理连接池与重试。
 *
 * Fake 实现**不执行**这些操作，只返回预置的结果或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖 Redis 状态，不依赖网络。
 */
export interface FakeRedisBehavior {
  /** 命令延迟毫秒数 */
  readonly commandDelayMs?: number;
  /** 连接故障 */
  readonly connectionError?: Error;
  /** 命令故障 */
  readonly commandError?: Error;
  /** 按命令名编排特定命令的行为 */
  readonly byCommand?: Record<string, FakeCommandBehavior>;
}

export interface FakeCommandBehavior {
  /** 命令结果 */
  readonly result?: unknown;
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障 */
  readonly error?: Error;
}

/**
 * 包装 `Redis`，注入编排行为。
 */
export function wrapRedis(redis: Redis, behavior: FakeRedisBehavior): Redis {
  const handler: ProxyHandler<Redis> = {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      // 只包装函数（命令）
      if (typeof value !== 'function') {
        return value;
      }

      return async (...args: unknown[]) => {
        if (behavior.connectionError) {
          throw behavior.connectionError;
        }

        if (behavior.commandError) {
          throw behavior.commandError;
        }

        if (behavior.commandDelayMs !== undefined && behavior.commandDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, behavior.commandDelayMs));
        }

        // 按命令名编排特定命令
        const commandName = String(prop);
        const commandBehavior = behavior.byCommand?.[commandName];
        if (commandBehavior !== undefined) {
          if (commandBehavior.error) {
            throw commandBehavior.error;
          }
          if (commandBehavior.delayMs !== undefined && commandBehavior.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, commandBehavior.delayMs));
          }
          if (commandBehavior.result !== undefined) {
            return commandBehavior.result;
          }
        }

        return value.apply(target, args);
      };
    },
  };

  return new Proxy(redis, handler);
}
