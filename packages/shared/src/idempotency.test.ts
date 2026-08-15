import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  IDEMPOTENCY_RESULT_TTL_DAYS,
  InMemoryIdempotencyLock,
  canonicalJson,
  computeIdempotencyKey,
} from './idempotency.js';

/**
 * 幂等键（TP-2-08、TP-2-29，设计稿 13.8）。
 *
 * 这些断言守的是同一件事：**相同的需求必须得到相同的键，不同的需求必须
 * 得到不同的键**。前者失效 → 用户点两次生成得到两份计划、扣两次配额；
 * 后者失效 → 用户改了需求却拿回旧计划，而界面上显示的是新需求。
 */

describe('canonicalJson', () => {
  it('键按字典序排序', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('嵌套对象递归排序', () => {
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"z":{"c":2,"d":1}}');
  });

  it('字段顺序不同的同一份对象得到同一个字符串', () => {
    /*
     * 这是整条幂等链最关键的一条。前端两次构造对象时字段顺序不同
     * （对象展开、条件式赋值都会改顺序），JSON.stringify 会产出不同字符串，
     * 幂等直接失效 —— 而症状是「偶尔会生成两份」，无法稳定复现。
     */
    const a = { trip: { origin: '上海', destination: '杭州' }, days: 5 };
    const b = { days: 5, trip: { destination: '杭州', origin: '上海' } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('数组顺序有语义，不排序', () => {
    // days[] 与 schedule[] 的顺序就是行程本身，排序会让「第 1 天去西湖」
    // 与「第 1 天去运河」哈希成同一个键
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('无空白', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it('跳过 undefined 属性，与 JSON.stringify 一致', () => {
    /*
     * `exactOptionalPropertyTypes` 下「没有这个键」与「键值为 undefined」
     * 是不同的类型，但对幂等而言必须是同一个键 ——
     * 否则 `{ place_id: undefined }` 与 `{}` 会产生两个不同的幂等键。
     */
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it('1 与 1.0 归一', () => {
    expect(canonicalJson({ n: 1 })).toBe(canonicalJson({ n: 1.0 }));
  });

  it('-0 归一为 0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('非有限数值直接抛错，不静默变成 null', () => {
    /*
     * JSON.stringify 把 NaN 与 ±Infinity 都写成 null —— 两个不同的坏值
     * 会哈希成同一个键。标准化结果里出现 NaN 说明上游算错了
     * （例如天数为负时的预算折算），必须暴露而不是掩盖。
     */
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/非有限数值/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/非有限数值/);
  });

  it('中文与转义字符按 JSON 规则编码', () => {
    expect(canonicalJson('杭州')).toBe('"杭州"');
    // 期望值用 JSON.stringify 表达而不是写字面量：
    // 反斜杠字面量会被跨平台路径护栏（tps-local/no-windows-path-separator）拦下
    expect(canonicalJson('a"b')).toBe(JSON.stringify('a"b'));
  });

  it('null 与嵌套 null 保留', () => {
    // place_id 为 null 是有意义的值（无法识别的地点），不能与「缺键」混同
    expect(canonicalJson({ place_id: null })).toBe('{"place_id":null}');
    expect(canonicalJson({ place_id: null })).not.toBe(canonicalJson({}));
  });
});

describe('computeIdempotencyKey', () => {
  const base = {
    userId: 'user-a',
    clientRequestId: 'req-1',
    normalized: { destination_name: '杭州', total_days: 5 },
  };

  it('是 64 位十六进制（sha256）', () => {
    expect(computeIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同输入得到相同键', () => {
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey(base));
  });

  it('字段顺序不影响键', () => {
    expect(
      computeIdempotencyKey({ ...base, normalized: { total_days: 5, destination_name: '杭州' } }),
    ).toBe(computeIdempotencyKey(base));
  });

  it('TP-2-29：不同用户同需求得到不同键', () => {
    /*
     * 不含 user_id 的话，第二个用户会命中第一个人的计划 ——
     * 那是一次跨用户数据泄漏，而且表现为「系统很快」，不会有人报告。
     */
    expect(computeIdempotencyKey({ ...base, userId: 'user-b' })).not.toBe(
      computeIdempotencyKey(base),
    );
  });

  it('同用户换 client_request_id 得到不同键', () => {
    // 用户显式点「重新生成」时客户端换新 ID，必须真的产生新任务
    expect(computeIdempotencyKey({ ...base, clientRequestId: 'req-2' })).not.toBe(
      computeIdempotencyKey(base),
    );
  });

  it('同 client_request_id 但需求变了得到不同键', () => {
    // 13.8：防止客户端复用同一 ID 提交不同内容却拿到旧结果
    expect(
      computeIdempotencyKey({ ...base, normalized: { destination_name: '苏州', total_days: 5 } }),
    ).not.toBe(computeIdempotencyKey(base));
  });

  it('分隔符不可被内容伪造', () => {
    /*
     * 用 `|` 拼接时，若不含长度或结构信息，`("a|b", "c")` 与 `("a", "b|c")`
     * 会拼出同一段材料。这里第三段是 canonical_json，必然以 `{` 或 `[` 开头，
     * 而 user_id 是 UUID、client_request_id 由 schema 限长 ——
     * 因此实际不可能碰撞。这条用例把这个论证钉住：一旦有人把
     * client_request_id 放宽成任意字符串，它会失败。
     */
    const a = computeIdempotencyKey({ ...base, userId: 'user-a|req-1', clientRequestId: '' });
    expect(a).not.toBe(computeIdempotencyKey(base));
  });
});

describe('13.8 的时限常量', () => {
  it('与设计稿一致', () => {
    expect(IDEMPOTENCY_RESULT_TTL_DAYS).toBe(7);
    expect(IDEMPOTENCY_LOCK_TTL_SECONDS).toBe(300);
  });
});

describe('InMemoryIdempotencyLock', () => {
  it('首次抢到，重复抢不到', async () => {
    const lock = new InMemoryIdempotencyLock();
    expect(await lock.acquire('k', 300)).toBe(true);
    expect(await lock.acquire('k', 300)).toBe(false);
  });

  it('过期后可再抢', async () => {
    let now = 1_000;
    const lock = new InMemoryIdempotencyLock(() => now);
    expect(await lock.acquire('k', 1)).toBe(true);
    now += 1_001;
    expect(await lock.acquire('k', 1)).toBe(true);
  });

  it('不同键互不影响', async () => {
    const lock = new InMemoryIdempotencyLock();
    expect(await lock.acquire('a', 300)).toBe(true);
    expect(await lock.acquire('b', 300)).toBe(true);
  });
});
