import { createHash } from 'node:crypto';

/**
 * 幂等键（TP-2-08、TP-2-29，设计稿 13.8）。
 *
 * ```text
 * idempotency_key = sha256(
 *   user_id + "|" + client_request_id + "|" + canonical_json(NormalizedTravelRequest)
 * )
 * ```
 *
 * ## 为什么必须把标准化结果一起哈希
 *
 * 13.8：「可以防止客户端复用同一 `client_request_id` 提交不同内容却拿到
 * 旧结果」。只哈希 `client_request_id` 的话，前端某个 bug 导致 ID 没更新时，
 * 用户改完需求重新提交会拿回上一份计划 —— 而界面上显示的是新需求，
 * 用户完全无法理解为什么行程没变。
 *
 * ## 为什么必须含 user_id
 *
 * 13.8 最后一段：两个不同用户（含两个匿名用户）提交完全相同的旅行需求
 * 会各自生成一份。不含 `user_id` 的话，第二个用户会命中第一个人的计划 ——
 * 那是一次跨用户数据泄漏，而且看起来像「系统很快」。
 */

/**
 * 规范化 JSON：键按字典序递归排序、无空白、数值规范化。
 *
 * ## 为什么不能直接用 JSON.stringify
 *
 * `JSON.stringify` 保留**插入顺序**。同一份需求，前端两次构造对象时字段
 * 顺序不同（对象展开、条件式赋值都会改变顺序），得到的字符串就不同，
 * 哈希也不同 —— 幂等直接失效，用户点两次「生成」得到两份计划，扣两次配额。
 *
 * ## 数值规范化
 *
 * `1` 与 `1.0` 在 JS 里是同一个值，`Number.prototype.toString` 已经把它们
 * 归一到 `"1"`。需要额外处理的是三种非有限值：`NaN` / `±Infinity`
 * 被 `JSON.stringify` 写成 `null`，两个不同的坏值会哈希成同一个键。
 * 这里直接抛错 —— 标准化结果里出现 NaN 说明上游算错了，
 * 而把它悄悄当成 null 会让两个不同的错误请求共用一个幂等键。
 *
 * `-0` 归一为 `0`：它们语义相同，而 `(-0).toString()` 是 `"0"`，
 * `JSON.stringify(-0)` 也是 `"0"`，这里显式写出来是为了让这条规则可查。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical_json 不接受非有限数值：${String(value)}`);
    }
    return Object.is(value, -0) ? '0' : String(value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  /*
   * `undefined` 作为数组元素时序列化为 `null`（与 `JSON.stringify` 一致）；
   * 作为对象属性值时该键被整体跳过，见下面的对象分支。
   */
  if (typeof value === 'undefined') return 'null';

  if (Array.isArray(value)) {
    // 数组顺序有语义（days[]、schedule[]），**不排序**
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // 跳过 undefined 属性，与 JSON.stringify 的行为一致
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }

  throw new Error(`canonical_json 不支持的类型：${typeof value}`);
}

export interface IdempotencyKeyInput {
  readonly userId: string;
  readonly clientRequestId: string;
  /** 标准化后的请求体（`NormalizedTravelRequest`） */
  readonly normalized: unknown;
}

export function computeIdempotencyKey(input: IdempotencyKeyInput): string {
  const material = [input.userId, input.clientRequestId, canonicalJson(input.normalized)].join('|');

  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * 导出的幂等键（13.5，TP-4-13）。
 *
 * 13.5：「相同 `(plan_version_id, format, scope, day_numbers, template_id)`
 * 的未过期已完成导出**直接返回原 `export_id`**，不重复渲染」。
 *
 * ## 为什么这里不含 `user_id`，而生成的幂等键含
 *
 * 生成的幂等键必须含 `user_id`（13.8：两个用户提交相同需求各自生成一份，
 * 这是归属隔离的必然要求）。导出不同：`plan_version_id` 本身就只属于一个
 * 用户 —— 一个版本导出成 PDF，结果与谁点的按钮无关，逐字节相同。
 * 加上 `user_id` 只会让「同一个人换个会话再点一次」变成一次重复渲染。
 *
 * ## `day_numbers` 排序后再入哈希
 *
 * `[3]` 与 `[3]` 显然相同，但 V2 的多选天导出会出现 `[1,3]` 与 `[3,1]`——
 * 它们要的是同一份产物。不排序的话会渲染两遍，而两份产物内容一致、
 * 键不同，缓存与配额都白算一次。
 */
export function computeExportIdempotencyKey(input: {
  readonly planVersionId: string;
  readonly format: string;
  readonly scope: string;
  readonly dayNumbers: readonly number[] | null;
  readonly templateId: string;
}): string {
  const days =
    input.dayNumbers === null ? '' : [...input.dayNumbers].sort((a, b) => a - b).join(',');
  const material = [input.planVersionId, input.format, input.scope, days, input.templateId].join(
    '|',
  );

  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * 13.8：幂等结果有效期 7 天。
 *
 * 超过后同一幂等键视为新任务 —— 否则用户想「重新生成」时会被永久锁死在
 * 旧结果上。（用户显式点「重新生成」时客户端换新 `client_request_id`，
 * 这个期限是给「忘了换」的情况兜底。）
 */
export const IDEMPOTENCY_RESULT_TTL_DAYS = 7;

/** 13.8：Redis 锁的 TTL，300 秒 */
export const IDEMPOTENCY_LOCK_TTL_SECONDS = 300;

/**
 * 幂等快路径锁。
 *
 * 13.8 明确「Redis 锁是快路径，`travel_requests.idempotency_key` 上的
 * 唯一索引是**最终真相**」。因此这个接口的实现**允许失败** ——
 * `acquire` 抛错时调用方继续走数据库路径，唯一索引仍然保证不重复生成。
 */
export interface IdempotencyLock {
  /** 抢到锁返回 true；已被占用返回 false */
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
}

/** 进程内实现：单测与单实例本地开发用。**多实例下无效**（各进程各一份） */
export class InMemoryIdempotencyLock implements IdempotencyLock {
  private readonly held = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const expiresAt = this.held.get(key);
    const current = this.now();
    if (expiresAt !== undefined && expiresAt > current) return Promise.resolve(false);

    this.held.set(key, current + ttlSeconds * 1000);
    return Promise.resolve(true);
  }
}
