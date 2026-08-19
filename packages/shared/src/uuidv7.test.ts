import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { uuidv7, uuidv7Boundary, uuidv7Date } from './uuidv7.js';

/**
 * UUIDv7（TP-6-10，设计稿 15.4 / R-48 的 `content_id`）。
 *
 * 三组不变式：**形状合法**（否则 `uuid` 列拒绝写入）、**时间有序**
 * （否则 13.11 的主键范围扫描无意义）、**边界包含**（否则范围扫描漏行）。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('形状', () => {
  it('是合法的 UUID 文本形式', () => {
    expect(uuidv7()).toMatch(UUID_PATTERN);
  });

  it('版本位为 7', () => {
    const hex = uuidv7().replace(/-/g, '');
    expect(hex[12]).toBe('7');
  });

  it('变体位在 8～b（RFC 9562 的 10 前缀）', () => {
    for (let i = 0; i < 200; i += 1) {
      const hex = uuidv7().replace(/-/g, '');
      expect(['8', '9', 'a', 'b']).toContain(hex[16]);
    }
  });

  it('同一毫秒内两次生成不相等（74 位随机）', () => {
    const t = Date.UTC(2026, 7, 19, 8, 0, 0);
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7(t)));
    expect(ids.size).toBe(500);
  });

  it('超出 48 位可表示范围的时间戳被拒', () => {
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });
});

describe('时间有序（13.11 的主键范围扫描前提）', () => {
  it('相邻毫秒生成的 ID 字典序递增', () => {
    const base = Date.UTC(2026, 7, 19);
    const ids = Array.from({ length: 50 }, (_, i) => uuidv7(base + i));
    expect([...ids].sort()).toEqual(ids);
  });

  it('跨过 2^32 毫秒的时刻仍然有序（48 位写入的边界）', () => {
    /*
     * 2^32 毫秒 ≈ 1970-02-19。手写移位实现最容易在这里出错：
     * JavaScript 的按位运算按 32 位有符号数做，`ms >> 32` 得到的是 `ms >> 0`。
     * 一天只发生一次的错误值得一条专门的用例。
     */
    const before = 2 ** 32 - 1;
    const after = 2 ** 32 + 1;
    expect(uuidv7(before) < uuidv7(after)).toBe(true);
  });

  it('远期时刻（2100 年）仍然有序', () => {
    const y2100 = Date.UTC(2100, 0, 1);
    expect(uuidv7(Date.UTC(2026, 0, 1)) < uuidv7(y2100)).toBe(true);
  });
});

describe('uuidv7Date', () => {
  it('往返一致', () => {
    const t = Date.UTC(2026, 7, 19, 8, 30, 15, 123);
    expect(uuidv7Date(uuidv7(t))?.getTime()).toBe(t);
  });

  it('v4（randomUUID）返回 null，不返回由随机位算出的假时刻', () => {
    /*
     * 这一条是 R-53 的依据。库里存在 P2～P5 期间产生的 v4 行，
     * 对它们「时间前缀」是随机数据 —— 返回一个 1974 年或 8000 年会让
     * 15.4 的路径与 13.11 的检索都指向错误的时间段。
     */
    for (let i = 0; i < 50; i += 1) {
      expect(uuidv7Date(randomUUID())).toBeNull();
    }
  });

  it('格式非法返回 null', () => {
    expect(uuidv7Date('not-a-uuid')).toBeNull();
    expect(uuidv7Date('')).toBeNull();
    expect(uuidv7Date('0192a3b4-c5d6-7890-8abc-def012345')).toBeNull();
  });

  it('大写输入也能解析（PostgreSQL 可能返回大写）', () => {
    const id = uuidv7(Date.UTC(2026, 7, 19));
    expect(uuidv7Date(id.toUpperCase())?.getTime()).toBe(Date.UTC(2026, 7, 19));
  });
});

describe('uuidv7Boundary（13.11 的范围扫描边界）', () => {
  it('边界值本身是合法 UUIDv7', () => {
    const at = new Date('2026-08-19T00:00:00Z');
    for (const edge of ['min', 'max'] as const) {
      const boundary = uuidv7Boundary(at, edge);
      expect(boundary).toMatch(UUID_PATTERN);
      const hex = boundary.replace(/-/g, '');
      expect(hex[12]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(hex[16]);
    }
  });

  it('同一毫秒生成的任意 ID 都落在 [min, max] 之内', () => {
    const t = Date.UTC(2026, 7, 19, 12, 34, 56, 789);
    const at = new Date(t);
    const min = uuidv7Boundary(at, 'min');
    const max = uuidv7Boundary(at, 'max');

    // 1000 次采样：随机位取到极值时才可能暴露边界写错
    for (let i = 0; i < 1000; i += 1) {
      const id = uuidv7(t);
      expect(id >= min, `${id} < ${min}`).toBe(true);
      expect(id <= max, `${id} > ${max}`).toBe(true);
    }
  });

  it('区间外的 ID 不落在范围内（前后各一毫秒）', () => {
    const t = Date.UTC(2026, 7, 19, 12, 0, 0, 0);
    const min = uuidv7Boundary(new Date(t), 'min');
    const max = uuidv7Boundary(new Date(t), 'max');

    expect(uuidv7(t - 1) < min).toBe(true);
    expect(uuidv7(t + 1) > max).toBe(true);
  });

  it('min < max', () => {
    const at = new Date('2026-08-19T00:00:00Z');
    expect(uuidv7Boundary(at, 'min') < uuidv7Boundary(at, 'max')).toBe(true);
  });

  it('一段时间范围的边界能覆盖其中生成的全部 ID', () => {
    const from = Date.UTC(2026, 7, 1);
    const to = Date.UTC(2026, 8, 1);
    const lower = uuidv7Boundary(new Date(from), 'min');
    const upper = uuidv7Boundary(new Date(to), 'max');

    for (let i = 0; i < 200; i += 1) {
      const t = from + Math.floor(((to - from) * i) / 200);
      const id = uuidv7(t);
      expect(id >= lower && id <= upper).toBe(true);
    }
  });

  it('无效日期抛错', () => {
    expect(() => uuidv7Boundary(new Date('nope'), 'min')).toThrow(RangeError);
  });
});
