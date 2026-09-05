import type { ObjectStorage } from '@tps/storage';

/**
 * Fake 对象存储实现。
 *
 * 用于测试：模拟对象存储的上传/下载/预签名延迟与故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`uploadDelayMs` 模拟上传慢，`presignDelayMs` 模拟预签名慢；
 * - **故障模拟**：`uploadError` 模拟上传失败，`downloadError` 模拟下载失败。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/storage/src/storage.ts`）会：
 * 1. 连接 S3 / MinIO；
 * 2. 调用 `PutObjectCommand` / `GetObjectCommand`；
 * 3. 管理预签名 URL 的过期。
 *
 * Fake 实现**不执行**这些操作，只记录写入事实或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖 S3 状态，不依赖网络。
 */
export interface FakeStorageBehavior {
  /** 上传延迟毫秒数 */
  readonly uploadDelayMs?: number;
  /** 下载延迟毫秒数 */
  readonly downloadDelayMs?: number;
  /** 预签名延迟毫秒数 */
  readonly presignDelayMs?: number;
  /** 上传故障 */
  readonly uploadError?: Error;
  /** 下载故障 */
  readonly downloadError?: Error;
}

/**
 * 包装 `ObjectStorage`，注入编排行为。
 */
export function wrapStorage(storage: ObjectStorage, behavior: FakeStorageBehavior): ObjectStorage {
  return {
    ...storage,
    put: async (input) => {
      if (behavior.uploadError) {
        throw behavior.uploadError;
      }

      if (behavior.uploadDelayMs !== undefined && behavior.uploadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.uploadDelayMs));
      }

      return storage.put(input);
    },
  };
}
