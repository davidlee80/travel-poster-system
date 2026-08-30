import { zipSync } from 'fflate';

export interface DailyPng {
  readonly dayNumber: number | null;
  readonly bytes: Uint8Array;
}

/** `PNG + ALL_DAYS` 的附加 ZIP；文件名补零保证解压后仍按天排序。 */
export function buildDailyPngZip(captured: readonly DailyPng[]): Uint8Array {
  const entries = Object.fromEntries(
    [...captured]
      .sort((a, b) => (a.dayNumber ?? 0) - (b.dayNumber ?? 0))
      .map((item) => [`day-${String(item.dayNumber ?? 0).padStart(2, '0')}.png`, item.bytes]),
  );
  return zipSync(entries, { level: 6 });
}
