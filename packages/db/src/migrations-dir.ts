import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `infrastructure/migrations` 的绝对路径。
 *
 * 用 `fileURLToPath` 而不是 `new URL(...).pathname` —— 后者在 Windows 上
 * 返回 `/E:/Docker/...` 这种带前导斜杠的非法路径，`readdir` 直接报
 * ENOENT。之前集成测试里就是这么写的，因为它只在 Linux CI 上跑过，
 * 本地一跑就暴露。同一个坑在 P1 的 next.config.mjs 里已经踩过一次。
 *
 * 抽成函数而不是在每个调用处重复：只要有第二处手写，就会有一处写错。
 */
export function migrationsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/migrations-dir.js 与 src/migrations-dir.ts 都在包根下一层
  return path.resolve(here, '..', '..', '..', 'infrastructure', 'migrations');
}
