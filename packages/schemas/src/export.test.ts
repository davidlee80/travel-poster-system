import { describe, expect, it } from 'vitest';

import { ExportArtifactSchema, ExportFileSchema } from './export.js';

describe('导出文件契约', () => {
  it('存储产物允许 ALL_DAYS PNG 的附加 ZIP', () => {
    expect(
      ExportArtifactSchema.safeParse({
        format: 'ZIP',
        day_number: null,
        url: 'https://exports.example/all-days.zip',
        byte_size: 123,
        expires_at: '2026-09-06T00:00:00.000Z',
        storage_key: 'exports/e-1/all-days.zip',
      }).success,
    ).toBe(true);
  });

  it('公网文件要求纯 ASCII 下载名', () => {
    const base = {
      format: 'PDF',
      day_number: null,
      url: 'https://exports.example/full-plan.pdf',
      byte_size: 123,
      expires_at: '2026-09-06T00:00:00.000Z',
    };

    expect(ExportFileSchema.safeParse({ ...base, file_name: 'chengdu-v1.pdf' }).success).toBe(true);
    expect(ExportFileSchema.safeParse({ ...base, file_name: '成都攻略.pdf' }).success).toBe(false);
  });
});
