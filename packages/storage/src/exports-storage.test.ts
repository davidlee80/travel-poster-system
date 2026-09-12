import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';

import { exportFileName, InMemoryExportStorage, S3ExportStorage } from './exports-storage.js';

describe('导出存储', () => {
  it('HTTP 成功但对象删除失败时拒绝完成，调用方可以重试', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    send.mockResolvedValueOnce({ Errors: [{ Key: 'failed.pdf', Code: 'AccessDenied' }] } as never);
    send.mockResolvedValueOnce({ Deleted: [{ Key: 'failed.pdf' }] } as never);
    const storage = new S3ExportStorage({
      endpoint: 'https://s3.test',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    });
    try {
      await expect(storage.delete(['failed.pdf'])).rejects.toThrow('AccessDenied');
      await expect(storage.delete(['failed.pdf'])).resolves.toBeUndefined();
    } finally {
      storage.destroy();
      send.mockRestore();
    }
  });

  it('ZIP 使用稳定的内部对象名', () => {
    expect(exportFileName('ZIP', 'ALL_DAYS', null)).toBe('all-days.zip');
  });

  it('预签名携带 ASCII 下载文件名', async () => {
    const storage = new InMemoryExportStorage();
    const signed = await storage.presign('exports/e-1/full-plan.pdf', 60, {
      downloadName: 'cheng-du-wanzheng-gonglue-v1.pdf',
    });

    expect(signed.url).toContain('response-content-disposition=');
    expect(decodeURIComponent(signed.url)).toContain(
      'attachment; filename="cheng-du-wanzheng-gonglue-v1.pdf"',
    );
  });
});
