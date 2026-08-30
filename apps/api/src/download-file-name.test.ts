import { describe, expect, it } from 'vitest';

import { asciiPinyinSlug, buildDownloadFileName } from './download-file-name.js';

describe('buildDownloadFileName', () => {
  const context = {
    destinationName: '成都',
    startDate: '2026-10-01',
    totalDays: 3,
    versionNumber: 3,
    scope: 'FULL_PLAN' as const,
  };

  it('中文目的地转为无声调小写拼音', () => {
    expect(asciiPinyinSlug('成都 / 春熙路')).toBe('chengdu-chunxilu');
  });

  it('完整攻略使用 ASCII 拼音文件名', () => {
    expect(buildDownloadFileName(context, { format: 'PDF', dayNumber: null })).toBe(
      'chengdu-2026-10-01_2026-10-03-wanzheng-gonglue-v3.pdf',
    );
  });

  it('每日文件带实际日期和补零天号', () => {
    expect(buildDownloadFileName(context, { format: 'PNG', dayNumber: 2 })).toBe(
      'chengdu-2026-10-02-day-02-v3.png',
    );
  });

  it('每日 ZIP 使用合集标识', () => {
    expect(
      buildDownloadFileName({ ...context, scope: 'ALL_DAYS' }, { format: 'ZIP', dayNumber: null }),
    ).toBe('chengdu-2026-10-01_2026-10-03-meiri-gonglue-v3.zip');
  });

  it('最终文件名只含安全 ASCII 且不超过 120 字符', () => {
    const name = buildDownloadFileName(
      { ...context, destinationName: '这是一个非常非常长的目的地'.repeat(20) },
      { format: 'PDF', dayNumber: null },
    );
    expect(name).toMatch(/^[a-z0-9][a-z0-9._-]+$/);
    expect(name.length).toBeLessThanOrEqual(120);
  });
});
