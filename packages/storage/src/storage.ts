import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

/**
 * S3 兼容对象存储（设计稿 1.1「文件」、11.2 第 6 步、二十章「外部图片」）。
 *
 * ## 素材 URL 必须是长期有效的
 *
 * 导出文件用预签名 URL（13.6：7 天，过期重签不重渲染），但**素材不能**：
 * 素材 URL 会被写进 `plan_presentations.view_model`，而那张表 19.3 明确
 * 「永久」保存。写进去一个 7 天后失效的 URL，等于让所有旧计划页
 * 在一周后集体变成裂图 —— 而 ViewModel 是不重算的。
 *
 * 因此素材桶按「公开读」部署（生产走 CDN），`storage_url` 存绝对 URL。
 * 这也是二十章要求「外部图片下载转存到自己的对象存储」的落点：
 * 转存之后 URL 由我们控制，不会因为对方防盗链或删图而失效。
 *
 * ## 为什么只有 put 和一个受限的 delete
 *
 * 读路径是浏览器与 Chromium 直接按 URL 取，不经过后端。
 *
 * **已入库的素材不物理删除** —— 下架用 19.3 的 `assets.status` 标记代替。
 * 理由在上面：素材 URL 被写进了永久保存的 ViewModel，删掉对象就是让旧计划页
 * 集体裂图。这一条不变。
 *
 * `delete` 存在只为了一个场景：**上传成功但从未落库的残留**。
 * 那种对象没有任何 `assets` 行指向它，因此它**不是素材** —— 它是我们自己
 * 一次写入失败的垃圾，删它不涉及「谁有权删素材」那个问题。
 *
 * 接口只收**显式键列表**，没有也不会有 `deletePrefix`（与 `ExportStorage` 同一
 * 处理）：前缀删除只要一个拼错的参数就能清空整个素材池，而那一步不可逆。
 */

export interface PutObjectInput {
  /** 对象键，不含桶名。形如 `assets/hero/<uuid>.webp` */
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  /**
   * 缓存头。素材是内容寻址的（键里含 UUID 或哈希），
   * 因此可以长期强缓存 —— 同一个键的内容永不改变。
   */
  readonly cacheControl?: string;
}

export interface ObjectStorage {
  /** 写入并返回可直接访问的绝对 URL */
  put(input: PutObjectInput): Promise<string>;
  /** 键 → 绝对 URL（不发请求） */
  urlFor(key: string): string;
  /**
   * 删掉**从未落库的上传残留**。见文件头：不得用于删除已入库素材。
   *
   * 失败**不阻断**调用方的主流程：调用点那时已经完成了业务目标（复用到了
   * 先到者的素材），清垃圾失败不该把那个成功变成失败。因此实现不保证原子性，
   * 调用方应当 catch 并记一条日志。
   */
  delete(keys: readonly string[]): Promise<void>;
}

export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** MinIO 必须为 true（它不支持 virtual-hosted 风格的桶名） */
  readonly forcePathStyle: boolean;
  /**
   * 对外可访问的基地址。缺省时用 `endpoint/bucket`。
   *
   * 生产环境这里填 CDN 域名 —— 素材 URL 会被写进 ViewModel 长期保存，
   * 后期换 CDN 时旧 URL 仍要能访问，因此这一项必须可配置而不是拼出来的。
   */
  readonly publicBaseUrl?: string;
}

/** 素材可长期强缓存：键含 UUID/哈希，内容不变 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly base: string;

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
    this.base = trimSlash(config.publicBaseUrl ?? `${trimSlash(config.endpoint)}/${config.bucket}`);
  }

  async put(input: PutObjectInput): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl ?? IMMUTABLE_CACHE_CONTROL,
      }),
    );
    return this.urlFor(input.key);
  }

  urlFor(key: string): string {
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    /*
     * 不分批：这个方法的唯一调用点一次只传两个键（原图 + 缩略图），
     * 而 `DeleteObjects` 单次上限是 1000。加分批循环是为一个不存在的场景
     * 写代码 —— `ExportStorage.delete` 需要分批是因为它按任务批量删导出。
     */
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * 进程内实现，供单测与无 MinIO 的本地运行使用。
 *
 * 保留写入内容而不是只记键：11.2 的后处理测试需要断言
 * 「上传的确实是 WebP、缩略图确实更小」，只记键就只能测「调用过」。
 */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  constructor(private readonly base = 'https://cdn.test.local/tps-assets') {}

  put(input: PutObjectInput): Promise<string> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return Promise.resolve(this.urlFor(input.key));
  }

  urlFor(key: string): string {
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }

  /** 删除后 `objects` 里真的没了 —— 测试要断言「孤儿确实被清掉」 */
  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
