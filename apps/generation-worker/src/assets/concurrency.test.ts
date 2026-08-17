import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

/**
 * 有界并发（21.2 的显式并发模型）。
 */

/** 记录并发峰值的可控任务 */
function tracker() {
  let active = 0;
  let peak = 0;
  const order: number[] = [];

  return {
    get peak() {
      return peak;
    },
    get order() {
      return order;
    },
    async run<T>(value: T, delayMs = 0): Promise<T> {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      order.push(Number(value));
      return value;
    },
  };
}

describe('mapWithConcurrency', () => {
  it('输出与输入同序，与完成顺序无关', async () => {
    const t = tracker();
    // 第一个最慢：完成顺序会是 [2, 1, 0]，但输出必须是 [0, 1, 2]
    const result = await mapWithConcurrency([0, 1, 2], 3, (value) =>
      t.run(value, (3 - value) * 20),
    );

    expect(result).toEqual([0, 1, 2]);
    expect(t.order).not.toEqual([0, 1, 2]);
  });

  it('并发峰值不超过上限', async () => {
    const t = tracker();
    const items = Array.from({ length: 20 }, (_v, i) => i);

    await mapWithConcurrency(items, 6, (value) => t.run(value, 5));
    expect(t.peak).toBeLessThanOrEqual(6);
    expect(t.peak).toBe(6);
  });

  it('工人模型：慢任务不挡住后面的（不是分批）', async () => {
    const t = tracker();
    /*
     * 分批实现下，第一批（[0,1]）要等最慢的 0 结束才开始第二批，
     * 因此 2 与 3 必然在 0 之后完成。工人模型里 1 一结束就取 2，
     * 于是 2 会先于 0 完成。
     */
    await mapWithConcurrency([0, 1, 2, 3], 2, (value) => t.run(value, value === 0 ? 60 : 5));

    expect(t.order[0]).toBe(1);
    expect(t.order.indexOf(2)).toBeLessThan(t.order.indexOf(0));
  });

  it('空数组直接返回空', async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([]);
  });

  it('上限大于元素数时不建多余的工人', async () => {
    const t = tracker();
    await mapWithConcurrency([1, 2], 10, (value) => t.run(value, 5));
    expect(t.peak).toBe(2);
  });

  it('上限小于 1 直接报错（而不是死循环或串行）', async () => {
    await expect(mapWithConcurrency([1], 0, () => Promise.resolve(1))).rejects.toThrow(/并发上限/);
  });

  it('异常不被吞掉', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, (value) =>
        value === 2 ? Promise.reject(new Error('炸了')) : Promise.resolve(value),
      ),
    ).rejects.toThrow('炸了');
  });
});
