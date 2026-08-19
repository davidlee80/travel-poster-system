import type { ExportStorage } from '@tps/storage';
import type { Logger } from '@tps/shared';

/**
 * 到期匿名用户的对象存储清理（TP-6-14，设计稿 15.1、R-50 / R-51）。
 *
 * ## 一条硬约束：以数据库归属为准，禁止按前缀
 *
 * R-50：`anon/` 前缀下混有**已升级 / 已归并**用户的长期数据 ——
 * 归并只改数据库行、对象零搬运（13.9.4），因此一个注册了三年的用户
 * 名下仍可能有当年匿名期产出的、键在 `anon/` 下的 PDF。
 *
 * 按前缀删（`aws s3 rm --recursive anon/`）会把它们一起删掉，而那是
 * 不可恢复的。因此：
 *
 *   - `ExportStorage` 接口里**没有** `deletePrefix`（见那里的说明）；
 *   - 要删哪些键由 `listExportObjectKeys(userId)` 从数据库给出；
 *   - `findExpiredAnonymous` 本来就不收 `MERGED` 行，因此已归并用户
 *     不会进入这条路径（有回归断言守着）。
 *
 * ## 删对象失败则不删行
 *
 * 由调用方通过 `purgeUser` 的 `beforeDelete` 钩子保证：本函数抛错 →
 * 事务回滚 → 行保留 → 下一轮重试。这里因此**不吞异常** ——
 * 吞掉的表现是「行删了、对象留着」，而那些对象再也推不出键。
 *
 * ## 为什么不复用 purge.ts 的 try/catch
 *
 * 那一层的 catch 是「单个用户失败不中断整批」，粒度是用户。
 * 本函数的失败要在**事务内**被感知，因此必须原样向上抛。
 */

export interface DeleteExportObjectsDeps {
  readonly storage: Pick<ExportStorage, 'delete'>;
  readonly logger: Logger;
}

export async function deleteExportObjects(
  deps: DeleteExportObjectsDeps,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) {
    /*
     * 没有产物是常见情况：多数匿名用户只生成计划、不导出。
     * 不记日志 —— 每天 500 条「该用户没有对象」只会淹掉真正的信息。
     */
    return;
  }

  await deps.storage.delete(keys);

  /*
   * 日志里只有数量，不含键。键里含 `user_id`（注册空间）与 `content_id`，
   * 而二十章的日志字段约束禁记标识符 —— 清理路径上没有任何需要按键排查的
   * 场景（要查的话 `pnpm content:find` 能从数据库还原）。
   */
  deps.logger.info({}, `已删除 ${keys.length} 个导出产物对象`);
}
