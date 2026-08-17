import { optionalBool, optionalString, requireString } from '@tps/shared';
import type { StorageConfig } from './storage.js';

/**
 * 对象存储配置（`env.example` 的 S3 段）。
 *
 * 桶名分素材与导出两个：素材公开读、永久保留（19.3），
 * 导出走预签名 URL、90 天生命周期规则（13.6）。两者的访问策略完全不同，
 * 放同一个桶会导致要么导出文件公开可读，要么素材 URL 会过期。
 */
export function loadAssetsStorageConfig(): StorageConfig {
  return {
    endpoint: requireString('S3_ENDPOINT'),
    region: optionalString('S3_REGION', 'us-east-1'),
    accessKeyId: requireString('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireString('S3_SECRET_ACCESS_KEY'),
    bucket: requireString('S3_BUCKET_ASSETS'),
    // MinIO 不支持 virtual-hosted 风格，本地必须为 true
    forcePathStyle: optionalBool('S3_FORCE_PATH_STYLE', true),
    ...(process.env['S3_PUBLIC_BASE_URL'] === undefined
      ? {}
      : { publicBaseUrl: requireString('S3_PUBLIC_BASE_URL') }),
  };
}
