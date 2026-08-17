import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMMUTABLE_CACHE_CONTROL, S3ObjectStorage } from './storage.js';

/**
 * 真实对象存储（需 MinIO，`pnpm infra:up`）。
 *
 * 只有真实存储能验证的三件事：对象真的写进去了、Content-Type 与
 * Cache-Control 真的被设上、`forcePathStyle` 下的 URL 真的可访问。
 * 用假实现测这些等于测自己写的 Map。
 *
 * 未设 `S3_ENDPOINT` 时整体跳过。
 */

const endpoint = process.env['S3_ENDPOINT'];
const bucket = process.env['S3_BUCKET_ASSETS'];
const describeIntegration =
  endpoint === undefined || bucket === undefined ? describe.skip : describe;

describeIntegration('对象存储（集成，需 MinIO）', () => {
  const config = {
    endpoint: endpoint ?? '',
    region: process.env['S3_REGION'] ?? 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'tps',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'tps_local_dev_only',
    bucket: bucket ?? '',
    forcePathStyle: true,
  };

  /*
   * 客户端在 beforeAll 里建，不在 describe 体里。
   *
   * `describe.skip` 仍会**执行**回调（它只跳过里面的 it），因此在这里
   * `new S3Client()` 会在没有 S3_ENDPOINT 的环境上抛错 ——
   * 表现是「整个套件失败」而不是「被跳过」，与 skip 的意图正好相反。
   */
  let storage: S3ObjectStorage;
  let client: S3Client;

  beforeAll(() => {
    storage = new S3ObjectStorage(config);
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  });

  afterAll(() => {
    storage.destroy();
    client.destroy();
  });

  /** 每次用不同的键，避免与上一次运行的对象混淆 */
  function key(): string {
    return `assets/test/${process.pid}-${Date.now()}.webp`;
  }

  it('写入后可读回，且 Content-Type 与强缓存头正确', async () => {
    const objectKey = key();
    const body = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

    const url = await storage.put({ key: objectKey, body, contentType: 'image/webp' });
    expect(url).toContain(objectKey);

    const got = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    expect(got.ContentType).toBe('image/webp');
    // 键含 UUID/哈希 → 内容不可变 → 可以长期强缓存
    expect(got.CacheControl).toBe(IMMUTABLE_CACHE_CONTROL);

    const bytes = await got.Body!.transformToByteArray();
    expect(new Uint8Array(bytes)).toEqual(body);
  });

  it('返回的 URL 与 urlFor 一致（写进 ViewModel 的就是它）', async () => {
    const objectKey = key();
    const url = await storage.put({
      key: objectKey,
      body: new Uint8Array([1]),
      contentType: 'image/webp',
    });
    expect(url).toBe(storage.urlFor(objectKey));
  });
});
