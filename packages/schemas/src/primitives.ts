import { z } from 'zod';
import { CurrencySchema } from './enums.js';

/**
 * 跨契约共用的基础类型。
 *
 * 日期与时间用显式正则而不是 `z.iso.date()`：
 *   1. 错误消息可控（面向 LLM 输出的修复提示需要说清格式）；
 *   2. 不随 Zod 的字符串格式 API 变动而失效；
 *   3. 设计稿对格式有精确规定（`YYYY-MM-DD`、24 小时制 `HH:mm`），
 *      正则就是这个规定的直接表达。
 */

/** `YYYY-MM-DD`。只校验形状，不校验日历有效性（2 月 30 日由业务规则处理） */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD 格式');
export type DateString = z.infer<typeof DateStringSchema>;

/** 24 小时制 `HH:mm`，00:00～23:59 */
export const TimeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间必须为 24 小时制 HH:mm 格式');
export type TimeString = z.infer<typeof TimeStringSchema>;

/** 非空且去除首尾空白后仍非空的字符串 */
export const NonEmptyStringSchema = z.string().trim().min(1, '不得为空字符串');

/**
 * 金额。
 *
 * 不在 schema 层限制非负 —— 负数金额是 REPAIRABLE 违规（业务规则 V-24，
 * 修复为置 0），schema 拒绝会把它升级成 BLOCKING。见 travel-plan.ts 的说明。
 */
export const MoneySchema = z.object({
  amount: z.number().finite(),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

/**
 * 地理位置。
 *
 * 经纬度不在 schema 层限制范围：越界坐标是 REPAIRABLE 违规（V-08，
 * 修复为置 null 并让该节点退出路线图）。
 */
export const GeoLocationSchema = z.object({
  name: NonEmptyStringSchema,
  place_id: z.string().nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
});
export type GeoLocation = z.infer<typeof GeoLocationSchema>;

/** 目的地标识。place_id 优先于 name 用于缓存键（设计稿 19.1） */
export const DestinationRefSchema = z.object({
  name: NonEmptyStringSchema,
  place_id: z.string().nullable(),
});
export type DestinationRef = z.infer<typeof DestinationRefSchema>;
