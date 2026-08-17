import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { optionalBool, optionalString, requireString } from '@tps/shared';

import type { PutObjectInput, StorageConfig } from './storage.js';

/**
 * 导出产物存储（TP-4-12/13，设计稿 13.5、13.6、19.3）。
 *
 * ## 为什么与素材存储分成两个类
 *
 * 两者的访问策略是**相反的**：
 *
 * ```text
 * 素材   公开读、永久有效       URL 写进 view_model 并永久保存（19.3）
 * 导出   预签名、7 天过期       13.6「下载 URL 为对象存储预签名地址」
 * ```
 *
 * 共用一个类只能取其中一种行为。取公开读的话，任何人拿到 URL 就能下载
 * 别人的行程 PDF（里面有完整日程与预算）；取预签名的话，素材 URL 会在
 * 一周后集体失效，而 ViewModel 是不重算的 —— 所有旧计划页变成裂图。
 *
 * 桶也是分开的（`S3_BUCKET_ASSETS` / `S3_BUCKET_EXPORTS`），
 * 因此桶策略与生命周期规则（19.3：导出 90 天）可以各自配置。
 *
 * ## 缓存头
 *
 * 导出对象**不设**长期强缓存。它的 URL 每 7 天换一次签名参数，
 * 而内容不变 —— 强缓存会让 CDN 按不同 URL 各存一份同样的 PDF。
 * 更重要的是：预签名 URL 一旦被 CDN 缓存，过期时刻就失去意义了。
 */

export interface ExportStorage {
  put(input: PutObjectInput): Promise<void>;
  /** 生成预签名下载地址。返回 URL 与它的过期时刻 */
  presign(
    key: string,
    ttlSeconds: number,
  ): Promise<{ readonly url: string; readonly expiresAt: Date }>;
}

/** 导出文件按 `exports/{export_id}/{文件名}` 组织，便于按任务整体清理 */
export function exportObjectKey(exportId: string, fileName: string): string {
  return `exports/${exportId}/${fileName}`;
}

/**
 * 导出文件名（13.5 的产物组织）。
 *
 * 天号补零，保证文件名的字典序与天号顺序一致 —— 用户下载一批 PNG 后
 * 在文件管理器里看到的顺序就是行程顺序（`day-02` 而不是 `day-2`）。
 */
export function exportFileName(
  format: 'PNG' | 'PDF',
  scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN',
  dayNumber: number | null,
): string {
  const extension = format.toLowerCase();
  if (dayNumber !== null) return `day-${String(dayNumber).padStart(2, '0')}.${extension}`;
  return scope === 'FULL_PLAN' ? `full-plan.${extension}` : `all-days.${extension}`;
}

export class S3ExportStorage implements ExportStorage {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };
    this.client = new S3Client(clientConfig);
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // 见文件头：预签名 URL 不能被长期缓存
        CacheControl: input.cacheControl ?? 'private, max-age=0, no-store',
      }),
    );
  }

  async presign(key: string, ttlSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
    /*
     * 过期时刻由**本地时钟 + TTL** 算出，而不是从 URL 的签名参数里解析。
     * 解析要依赖签名版本（SigV4 的 X-Amz-Date + X-Amz-Expires），
     * 而那是 SDK 的实现细节 —— 换一个 S3 兼容实现就可能解析不出来。
     * 代价是与服务端时钟有偏差时这个值略有误差，而 13.6 用它只是提示客户端
     * 「什么时候该重新调用本端点」，几秒的偏差无影响。
     */
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  destroy(): void {
    this.client.destroy();
  }
}

/** 进程内实现：单测与无 MinIO 的本地运行 */
export class InMemoryExportStorage implements ExportStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  constructor(private readonly base = 'https://exports.test.local') {}

  put(input: PutObjectInput): Promise<void> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return Promise.resolve();
  }

  presign(key: string, ttlSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    /*
     * 假签名里带一个递增的 nonce：13.6 的「重签名」测试要断言
     * 「URL 变了但没有重新渲染」，而两次返回同一个字符串就测不出来。
     */
    this.nonce += 1;
    return Promise.resolve({
      url: `${this.base}/${key}?sig=${this.nonce}&expires=${ttlSeconds}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
  }

  private nonce = 0;
}

/**
 * 导出桶的配置。与素材桶只差 `S3_BUCKET_EXPORTS` 一项，
 * 但**没有** `publicBaseUrl` —— 导出走预签名，不存在「对外基地址」。
 */
export function loadExportsStorageConfig(): StorageConfig {
  return {
    endpoint: requireString('S3_ENDPOINT'),
    region: optionalString('S3_REGION', 'us-east-1'),
    accessKeyId: requireString('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireString('S3_SECRET_ACCESS_KEY'),
    bucket: requireString('S3_BUCKET_EXPORTS'),
    forcePathStyle: optionalBool('S3_FORCE_PATH_STYLE', true),
  };
}
