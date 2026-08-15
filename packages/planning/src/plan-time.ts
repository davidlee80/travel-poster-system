/**
 * 业务规则校验与修复用到的日期／时间计算（TP-2-12）。
 *
 * 抽成独立模块是因为 V-03、V-06、V-07、V-12、V-13 五条规则都要做时间运算，
 * 而这类运算最容易出现「各处各写一遍、边界处理不一致」的问题 ——
 * 例如 V-07 用字符串比较判断 `end_time > start_time`（对 `09:00` 与 `10:00`
 * 恰好成立，因此测试会通过），而 V-12 平移后需要真正的分钟加法。
 * 统一走这里的分钟数表示，让两者不可能不一致。
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 一天的分钟数 */
export const MINUTES_PER_DAY = 24 * 60;

/** 一天中最晚的合法时刻（分钟）。`24:00` 不是合法 `HH:mm` */
export const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - 1;

/**
 * `HH:mm` → 自午夜起的分钟数。
 *
 * 格式非法直接抛错而不是返回 `NaN`：调用方拿到的时间已经过
 * `TimeStringSchema` 校验，非法值意味着有人绕过了 schema，
 * 而 `NaN` 会让后续所有比较**静默为 false**（`NaN > x` 恒假），
 * 表现为「规则明明实现了却什么都不报」。
 */
export function timeToMinutes(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (match === null) {
    throw new Error(`时间格式非法：${time}（应为 24 小时制 HH:mm）`);
  }
  // 正则已保证两个捕获组存在
  return Number(match[1]!) * 60 + Number(match[2]!);
}

/**
 * 分钟数 → `HH:mm`，越界时钳到当天边界。
 *
 * V-12 把整日行程平移到最早出发时间之后，末位条目可能被推过午夜。
 * 钳到 `23:59` 而不是回绕到次日 `00:30`：回绕会产出一个「结束时间早于
 * 开始时间」的条目，看起来像跨夜活动，而实际是排不下了 ——
 * 钳位后 V-13（最晚 22:00）必然报违规，问题因此暴露而不是被藏起来。
 */
export function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(LAST_MINUTE_OF_DAY, Math.round(minutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `YYYY-MM-DD` 加若干天。用 UTC 避免夏令时让日期错一天 */
export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) {
    throw new Error(`日期格式非法：${date}（应为 YYYY-MM-DD）`);
  }
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/** V-03 的日期锚点：第 `dayNumber` 天（1 起）应当落在哪一天 */
export function dateForDay(startDate: string, dayNumber: number): string {
  return addDays(startDate, dayNumber - 1);
}
