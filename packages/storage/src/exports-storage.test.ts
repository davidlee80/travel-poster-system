import { describe, expect, it } from 'vitest';

import { exportFileName, InMemoryExportStorage } from './exports-storage.js';

describe('导出存储', () => {
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
