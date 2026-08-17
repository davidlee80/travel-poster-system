import { describe, expect, it } from 'vitest';
import { InMemoryObjectStorage, S3ObjectStorage } from './storage.js';

/**
 * URL 构造（不需要真实存储）。
 *
 * `S3ObjectStorage` 的写入路径由 `storage.integration.test.ts` 覆盖（需 MinIO）。
 * 这里只测 URL 拼接 —— 它决定了**写进 ViewModel 并永久保存**的那个字符串，
 * 拼错一处的表现是所有页面裂图，而单测能在一秒内抓住。
 */

const config = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'tps',
  secretAccessKey: 'secret',
  bucket: 'tps-assets',
  forcePathStyle: true,
};

describe('URL 构造', () => {
  it('默认用 endpoint/bucket', () => {
    const storage = new S3ObjectStorage(config);
    expect(storage.urlFor('assets/hero/ab/abc.webp')).toBe(
      'http://localhost:9000/tps-assets/assets/hero/ab/abc.webp',
    );
    storage.destroy();
  });

  it('配置了公开基地址时用它（生产走 CDN）', () => {
    /*
     * 素材 URL 会被写进 plan_presentations.view_model 并永久保存（19.3），
     * 因此换 CDN 域名时旧 URL 仍要能访问 —— 这一项必须可配置，
     * 不能从 endpoint 拼出来。
     */
    const storage = new S3ObjectStorage({
      ...config,
      publicBaseUrl: 'https://cdn.example.com/assets-bucket/',
    });
    expect(storage.urlFor('assets/hero/ab/abc.webp')).toBe(
      'https://cdn.example.com/assets-bucket/assets/hero/ab/abc.webp',
    );
    storage.destroy();
  });

  it('多余的斜杠不会拼出 // ', () => {
    const storage = new S3ObjectStorage({ ...config, endpoint: 'http://localhost:9000/' });
    expect(storage.urlFor('/assets/x.webp')).toBe('http://localhost:9000/tps-assets/assets/x.webp');
    storage.destroy();
  });
});

describe('进程内实现', () => {
  it('保留写入内容，便于断言「上传的确实是 WebP」', async () => {
    const storage = new InMemoryObjectStorage();
    const url = await storage.put({
      key: 'assets/food/aa/aaa.webp',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/webp',
    });

    expect(url).toBe('https://cdn.test.local/tps-assets/assets/food/aa/aaa.webp');
    expect(storage.objects.get('assets/food/aa/aaa.webp')).toEqual({
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/webp',
    });
  });
});
