/**
 * S3 兼容对象存储（设计稿 1.1、11.2、二十章）。
 *
 * 单独成包而不是塞进 `@tps/shared`：AWS SDK 有几十个传递依赖，
 * 而 `@tps/shared` 被每个进程引用（含迁移 CLI）。
 */

export {
  IMMUTABLE_CACHE_CONTROL,
  InMemoryObjectStorage,
  S3ObjectStorage,
  type ObjectStorage,
  type PutObjectInput,
  type StorageConfig,
} from './storage.js';

export {
  InMemoryExportStorage,
  S3ExportStorage,
  exportFileName,
  exportObjectKey,
  loadExportsStorageConfig,
  type ExportStorage,
} from './exports-storage.js';

export { loadAssetsStorageConfig } from './config.js';
