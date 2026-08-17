/**
 * 有界并发（设计稿 21.2「显式并发模型」）。
 *
 * ```text
 * 天级素材解析     8      14 天分 2 批
 * 单天内槽位解析   6      1 Hero + 1 Map + 3 Food + 3 Photo
 * ```
 *
 * 不用 `Promise.all(items.map(fn))`：14 天 × 8 槽位 = 112 个并发请求会同时
 * 打向数据库连接池（上限 10）与嵌入服务，结果是大量请求排队等连接，
 * 而每个槽位的 800 毫秒预算（10.2）是从**发起时**开始算的 ——
 * 排队时间也计入，于是全部超时。
 *
 * 不引入 p-limit 之类的依赖：这段逻辑十几行，而依赖要长期跟着走。
 */

/**
 * 按 `limit` 并发映射，保持输出与输入同序。
 *
 * 出错不吞：调用方（解析编排）自己在每个槽位内部把异常转成
 * `FAILED`/`FALLBACK`，这里抛出意味着编排逻辑本身有缺陷，
 * 而那种缺陷不该被并发工具静默掉。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`并发上限必须 >= 1，实际为 ${limit}`);
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let next = 0;

  /*
   * 工人模型而不是「切成 N 批、批内 Promise.all」：
   * 分批会让每一批都等最慢的那个（14 天分 2 批时，第 2 批要等第 1 批
   * 全部结束），而工人模型是「谁空了谁取下一个」，尾部延迟明显更低。
   */
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
