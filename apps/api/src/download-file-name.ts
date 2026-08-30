import { pinyin } from 'pinyin-pro';

import type { ExportArtifactFormat } from '@tps/schemas';

const MAX_FILE_NAME_LENGTH = 120;

export interface DownloadNameContext {
  readonly destinationName: string;
  readonly startDate: string;
  readonly totalDays: number;
  readonly versionNumber: number;
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
}

export interface DownloadArtifactIdentity {
  readonly format: ExportArtifactFormat;
  readonly dayNumber: number | null;
}

/** 中文转无声调拼音，再收敛为跨平台安全的 ASCII slug。 */
export function asciiPinyinSlug(value: string): string {
  const transliterated = pinyin(value, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
    v: true,
  }).join('');

  return (
    transliterated
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'travel-plan'
  );
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scopeSuffix(context: DownloadNameContext, artifact: DownloadArtifactIdentity): string {
  const extension = artifact.format.toLowerCase();
  const version = `v${String(context.versionNumber)}`;

  if (artifact.dayNumber !== null) {
    const day = String(artifact.dayNumber).padStart(2, '0');
    const date = addDays(context.startDate, artifact.dayNumber - 1);
    return `${date}-day-${day}-${version}.${extension}`;
  }

  const endDate = addDays(context.startDate, Math.max(0, context.totalDays - 1));
  const range = `${context.startDate}_${endDate}`;
  const label =
    artifact.format === 'ZIP' || context.scope === 'ALL_DAYS'
      ? 'meiri-gonglue'
      : 'wanzheng-gonglue';
  return `${range}-${label}-${version}.${extension}`;
}

/**
 * 用户可见文件名。只截断目的地，日期、范围、版本和扩展名永远保留。
 */
export function buildDownloadFileName(
  context: DownloadNameContext,
  artifact: DownloadArtifactIdentity,
): string {
  const suffix = scopeSuffix(context, artifact);
  const destination = asciiPinyinSlug(context.destinationName);
  const maxDestinationLength = Math.max(1, MAX_FILE_NAME_LENGTH - suffix.length - 1);
  const shortened =
    destination.slice(0, maxDestinationLength).replace(/-+$/g, '') ||
    'travel-plan'.slice(0, maxDestinationLength);
  return `${shortened}-${suffix}`;
}
