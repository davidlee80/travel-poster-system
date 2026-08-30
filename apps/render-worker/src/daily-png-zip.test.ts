import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildDailyPngZip } from './daily-png-zip.js';

describe('全部每日 PNG 的 ZIP', () => {
  it('按补零天号打包，并保留每张 PNG 的字节', () => {
    const archive = buildDailyPngZip([
      { dayNumber: 2, bytes: new Uint8Array([2, 2]) },
      { dayNumber: 1, bytes: new Uint8Array([1]) },
    ]);
    const files = unzipSync(archive);

    expect(Object.keys(files)).toEqual(['day-01.png', 'day-02.png']);
    expect([...files['day-01.png']!]).toEqual([1]);
    expect([...files['day-02.png']!]).toEqual([2, 2]);
  });
});
