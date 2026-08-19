import { randomBytes } from 'node:crypto';

/**
 * UUIDv7（RFC 9562）—— 15.4 / R-48 的 `content_id`（TP-6-10）。
 *
 * ```text
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * ┌───────────────────────────────────────────────────────────────┐
 * │                     unix_ts_ms (48 位)                        │
 * ├───────┬───────────────────────┬───┬───────────────────────────┤
 * │ ver=7 │      rand_a (12)      │ 10│      rand_b (62 位)       │
 * └───────┴───────────────────────┴───┴───────────────────────────┘
 * ```
 *
 * ## 为什么用它替换 v4
 *
 * R-48：`travel_plan_versions.id` 同时是 FR-6.6.2 的「全局唯一、时间有序的
 * 内容 ID」。该次生成的全部产物（计划版本、展示数据、素材绑定、导出文件、
 * 存储键、日志与 Trace）都以它为主锚点。改造成本是零 schema 变更 ——
 * 该列本就由调用方生成，而 `UUID` 列不区分版本。
 *
 * 时间有序带来两件事：
 *   - 15.4 的存储路径可以从 ID 派生年月，**不引入第二个时间来源**；
 *   - 13.11 的时间范围检索可以在主键上做范围扫描，不需要新索引。
 *
 * ## 不引入 `uuidv7` npm 包
 *
 * 边界构造（`uuidv7Boundary`）是 13.11 的必需能力而那个包不提供，
 * 于是仍要自己算一半。P1 已确立同一判断（`oxipng` → `sharp` 内置压缩）：
 * 少一个依赖优于省二十行纯函数 —— 尤其这二十行的正确性完全由本文件的
 * 单测覆盖，而依赖的正确性要靠信任。
 *
 * ## 可枚举性不是问题
 *
 * UUIDv7 含时间前缀，因此比 v4 好猜。但随机位仍有 74 位，且 13.0 的
 * `user_id` 谓词 + 他人资源统一 404 才是访问控制的防线 —— ID 不可猜从来
 * 不是本设计的安全假设（3.6.5 的「不可枚举」针对的是**凭据**，
 * 而 `plan_version_id` 本就出现在 URL 里）。
 */

/** 十六进制 → 带连字符的 UUID 文本形式 */
function format(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xff_ff_ff_ff_ff_ff) {
    throw new RangeError(`uuidv7 的时间戳超出 48 位可表示范围：${nowMs}`);
  }

  const bytes = randomBytes(16);
  /*
   * `writeUIntBE` 的上限恰好是 6 字节 = 48 位，与 unix_ts_ms 字段等宽。
   * 用它而不是手写六次移位，是因为 48 位超出 `number` 的按位运算范围
   * （那些运算按 32 位有符号数做），手写必须走 BigInt 或分段 —— 两者都
   * 更容易在「刚好跨过 2^32」的时刻出错，而那种错一天只发生一次。
   */
  bytes.writeUIntBE(nowMs, 0, 6);

  // 版本位：高 4 位置 0111
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x70;
  // 变体位：高 2 位置 10
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;

  return format(bytes.toString('hex'));
}

/** UUID 文本形式的宽松校验（32 个十六进制位 + 4 个连字符） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 提取 UUIDv7 编码的时刻。
 *
 * **非 v7 返回 `null`** 而不是抛错。库里存在 P2～P5 期间产生的 v4 版本行
 * （`randomUUID()`），对它们「时间前缀」是随机数据 —— 返回一个由随机位算出的
 * 1974 年或 8000 年会让 15.4 的路径与 13.11 的检索都指向错误的时间段，
 * 而 `null` 让调用方能显式选择兜底（见 `@tps/storage` 的 `contentPrefix`）。
 */
export function uuidv7Date(id: string): Date | null {
  if (!UUID_PATTERN.test(id)) return null;

  const hex = id.replace(/-/g, '').toLowerCase();
  // 版本半字节是第 13 个十六进制位（字节 6 的高半字节）
  if (hex[12] !== '7') return null;

  return new Date(Number.parseInt(hex.slice(0, 12), 16));
}

/**
 * 某一毫秒内 UUIDv7 的最小 / 最大值，用于 13.11 的主键范围扫描。
 *
 * PostgreSQL 的 `uuid` 按**字节**比较，与十六进制字符串的字典序一致，
 * 因此 `id >= min AND id <= max` 就是「这段时间内生成的全部内容」。
 *
 * 尾部的取值不是简单的全 0 / 全 f：
 *   - 版本半字节固定为 `7`（否则边界值本身不是合法 v7，且会把 v4 行卷进来）；
 *   - 变体半字节只能是 `8`～`b`（RFC 9562 的 `10` 前缀），因此上界用 `b`
 *     而不是 `f` —— 用 `f` 会让边界值不是合法 UUID，某些驱动会直接拒绝解析。
 */
const MIN_TAIL = `7000${'8'}${'0'.repeat(15)}`;
const MAX_TAIL = `7fff${'b'}${'f'.repeat(15)}`;

export function uuidv7Boundary(at: Date, edge: 'min' | 'max'): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('uuidv7Boundary 收到无效日期');
  }

  const clamped = Math.min(Math.max(Math.trunc(ms), 0), 0xff_ff_ff_ff_ff_ff);
  const prefix = clamped.toString(16).padStart(12, '0');
  return format(prefix + (edge === 'min' ? MIN_TAIL : MAX_TAIL));
}
