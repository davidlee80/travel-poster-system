import {
  AssetSourceTypeSchema,
  AspectRatioSchema,
  LicenseTypeSchema,
  RepresentationTypeSchema,
  type AspectRatio,
} from '@tps/schemas';
import { z } from 'zod';

/**
 * 素材灌库清单（TP-3-06）。
 *
 * 一行一个素材的 JSONL，图片文件与清单放在同一目录：
 *
 * ```jsonl
 * {"file":"gongchen-bridge-01.jpg","role":"DESTINATION_PHOTO","entity_name":"拱宸桥",
 *  "destination_name":"杭州","destination_place_id":"cn-hangzhou",
 *  "license_type":"CC0","style_tags":["bridge","canal","daylight"]}
 * ```
 *
 * ## 为什么是清单 + 本地文件，而不是「给个 URL 让程序去抓」
 *
 * 二十章要求外部图片**下载、审核、转存**。审核是人的工作 ——
 * 版权是否允许商用、画面里有没有可识别的人脸、是不是拍的正确地点。
 * 让程序按 URL 自动抓取会把这一步跳过去，而跳过的后果是法务问题。
 * 因此入口是「已经审核过并落到本地的文件 + 人工填写的授权信息」。
 *
 * ## `license_type` 与 `attribution_text` 必须成对
 *
 * 需要署名的授权（CC BY 等）缺署名文案时，页面无法合规展示。
 * 这一条在清单层就拦住，而不是等到解析时 —— 那时素材已经入库，
 * 而入库后的修正要回填几千行。
 */
/**
 * 可灌库的角色。
 *
 * 用独立枚举而不是 `AssetRoleSchema` 加一条 refine：`ROUTE_MAP` 是程序生成的
 * （9.2「不调用图片模型」，也不从素材库来），它根本不该出现在清单里。
 * 写成枚举让类型也收窄 —— refine 只在运行期拦，编译期仍要处理
 * 一个不可能出现的分支。
 */
export const IngestableRoleSchema = z.enum(['HERO_BACKGROUND', 'FOOD_IMAGE', 'DESTINATION_PHOTO']);
export type IngestableRole = z.infer<typeof IngestableRoleSchema>;

export const SeedManifestEntrySchema = z
  .object({
    /** 相对清单目录的文件名 */
    file: z.string().min(1),
    role: IngestableRoleSchema,
    entity_name: z.string().min(1).nullable().default(null),
    destination_name: z.string().min(1).nullable().default(null),
    destination_place_id: z.string().min(1).nullable().default(null),
    title: z.string().min(1).nullable().default(null),
    style_tags: z.array(z.string().min(1)).default([]),
    license_type: LicenseTypeSchema,
    attribution_text: z.string().min(1).nullable().default(null),
    /** ISO 日期。无到期日的授权留空 */
    license_expires_at: z.string().nullable().default(null),
    source_type: AssetSourceTypeSchema.default('PLATFORM_LIBRARY'),
    representation_type: RepresentationTypeSchema.default('PHOTOGRAPHIC'),
    original_url: z.string().nullable().default(null),
    /** 覆盖角色默认的比例与最小宽度（11.2 的校验口径） */
    aspect_ratio: AspectRatioSchema.optional(),
    min_width: z.number().int().positive().optional(),
  })
  .refine(
    (entry) =>
      entry.license_type !== 'LICENSED' ||
      entry.attribution_text !== null ||
      entry.source_type === 'PLATFORM_LIBRARY',
    {
      message: '授权素材必须填 attribution_text（二十章：图片来源必须记录）',
      path: ['attribution_text'],
    },
  )
  .refine(
    (entry) => entry.source_type !== 'AI_GENERATED' || entry.representation_type === 'ILLUSTRATIVE',
    {
      message: 'AI 生成物必须标记为 ILLUSTRATIVE（9.4）',
      path: ['representation_type'],
    },
  );

export type SeedManifestEntry = z.infer<typeof SeedManifestEntrySchema>;

/**
 * 各角色的默认校验口径，与 `@tps/presentation` 的槽位生成保持一致。
 *
 * 两处不一致的表现是：灌进来的素材在解析时被 `aspect_ratio_score` 判低分，
 * 命中率莫名偏低 —— 而两边单独看都是「按规格做的」。
 */
export const ROLE_INGEST_DEFAULTS: Record<
  IngestableRole,
  { readonly aspectRatio: AspectRatio; readonly minWidth: number }
> = {
  HERO_BACKGROUND: { aspectRatio: '16:6', minWidth: 1600 },
  FOOD_IMAGE: { aspectRatio: '4:3', minWidth: 600 },
  DESTINATION_PHOTO: { aspectRatio: '16:9', minWidth: 800 },
};

export interface ParsedManifest {
  readonly entries: readonly SeedManifestEntry[];
  /** 行号 → 错误说明。有错行时调用方应当整体拒绝而不是跳过 */
  readonly errors: readonly { readonly line: number; readonly message: string }[];
}

/**
 * 解析 JSONL 清单。
 *
 * 错行**不跳过**而是收集后一起报出：跳过意味着「灌了 1998 条，两条静默丢失」，
 * 而清单是人工维护的，错行通常是同一类错误（比如整批漏填授权），
 * 一次报全比修一条跑一次快得多。
 */
export function parseSeedManifest(text: string): ParsedManifest {
  const entries: SeedManifestEntry[] = [];
  const errors: { line: number; message: string }[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) return;

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      errors.push({ line: index + 1, message: 'JSON 解析失败' });
      return;
    }

    const parsed = SeedManifestEntrySchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({
        line: index + 1,
        message: `${issue?.path.join('.') ?? '?'}: ${issue?.message ?? '校验失败'}`,
      });
      return;
    }

    entries.push(parsed.data);
  });

  return { entries, errors };
}
