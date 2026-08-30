import {
  DeleteObjectsCommand,
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
    options?: { readonly downloadName?: string },
  ): Promise<{ readonly url: string; readonly expiresAt: Date }>;
  /**
   * 逐键删除（TP-6-14，设计稿 15.1 / R-50）。
   *
   * **接口上没有 `deletePrefix`，也不该有。** R-50 是硬约束：
   * 「一切清理以数据库归属为准，禁止按路径前缀清理」—— `anon/` 前缀下混有
   * 已升级 / 已归并用户的长期数据（归并只改数据库行、对象零搬运），
   * 按前缀删会把它们一起删掉，而那是不可恢复的。
   *
   * 把这条约束表达为「接口里没有那个方法」而不是注释里的一句提醒：
   * 前者让违反它需要先改接口（一次会被 review 看见的改动），
   * 后者只需要有人没读注释。
   */
  delete(keys: readonly string[]): Promise<void>;
}

/**
 * 导出文件的**旧**键布局。
 *
 * @deprecated 15.4（R-49）改为按用户空间归档，新产物走
 * `@tps/storage` 的 `exportObjectKeyFor`。保留这个函数是为了让「旧键布局
 * 长什么样」在代码里有据可查 —— 实施计划第七章明确存量对象**不迁移**
 * （导出物 90 天自然过期），因此库里会同时存在两种键，
 * 而 retention 的清理读 `exports.files[].storage_key` 从而对两者都有效（R-53）。
 */
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
  format: 'PNG' | 'PDF' | 'ZIP',
  scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN',
  dayNumber: number | null,
): string {
  const extension = format.toLowerCase();
  if (format === 'ZIP') return `all-days.${extension}`;
  if (dayNumber !== null) return `day-${String(dayNumber).padStart(2, '0')}.${extension}`;
  return scope === 'FULL_PLAN' ? `full-plan.${extension}` : `all-days.${extension}`;
}

/** S3 的 DeleteObjects 单次上限。MinIO 同样遵守 */
const DELETE_BATCH_SIZE = 1000;

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

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    /*
     * `DeleteObjects` 一次最多 1000 个键（S3 API 限制，MinIO 同样遵守）。
     * 分批而不是逐个删：一个用户的产物通常是个位数，但 14 天 × PNG 的
     * `ALL_DAYS` 导出就有 14 个文件，几次导出后到几十个 —— 逐个删是几十次
     * 往返，而清理任务与在线流量共用带宽。
     */
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            /*
             * `Quiet: false` —— 要看到每个键的结果。安静模式只回错误，
             * 于是「删了几个」无从断言，而 TP-6-14 的顺序约束
             * （删对象失败则不删行）依赖于能判定失败。
             */
            Quiet: false,
          },
        }),
      );
    }
  }

  async presign(
    key: string,
    ttlSeconds: number,
    options?: { readonly downloadName?: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options?.downloadName === undefined
          ? {}
          : { ResponseContentDisposition: `attachment; filename="${options.downloadName}"` }),
      }),
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

  /**
   * 操作计数（TP-6-13 的「归并零搬运」断言）。
   *
   * R-50 要求归并只改数据库行、对象存储零搬运。「零」只能靠计数断言 ——
   * 看对象是否还在原处不够：一次「拷到新键再删旧键」的搬运结束后，
   * 对象**也**只在一个地方，从最终状态看不出中间发生过什么。
   */
  readonly counts = { put: 0, presign: 0, delete: 0 };

  constructor(private readonly base = 'https://exports.test.local') {}

  put(input: PutObjectInput): Promise<void> {
    this.counts.put += 1;
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    this.counts.delete += 1;
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  presign(
    key: string,
    ttlSeconds: number,
    options?: { readonly downloadName?: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    /*
     * 假签名里带一个递增的 nonce：13.6 的「重签名」测试要断言
     * 「URL 变了但没有重新渲染」，而两次返回同一个字符串就测不出来。
     */
    this.counts.presign += 1;
    this.nonce += 1;
    return Promise.resolve({
      url:
        `${this.base}/${key}?sig=${this.nonce}&expires=${ttlSeconds}` +
        (options?.downloadName === undefined
          ? ''
          : `&response-content-disposition=${encodeURIComponent(
              `attachment; filename="${options.downloadName}"`,
            )}`),
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
