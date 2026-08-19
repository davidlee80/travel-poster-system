import type { RetentionRepository } from '@tps/db';
import type { ExportStorage } from '@tps/storage';
import type { Logger } from '@tps/shared';

import { deleteExportObjects } from './objects.js';
import { anonPurgeTotal, knowledgeRows } from './retention-metrics.js';

/**
 * 保留期清理的一轮（TP-4-21/22/24，设计稿 15.1）。
 *
 * ## 分批 500，且**逐个用户一个事务**
 *
 * 15.1 说「分批（每批 500）级联删除」。批是**扫描**的粒度，不是事务的粒度：
 * 500 个用户放在一个事务里删，任何一个失败就整批回滚 —— 而一个用户的
 * 级联删除会碰到十几张表，失败面不小。逐个事务的代价是 500 次 BEGIN/COMMIT，
 * 收益是「一个坏数据不会挡住其余 499 个」。
 *
 * ## 一轮最多清多少
 *
 * 不设总量上限，但**每轮只扫一批**：清完 500 个就结束这一轮，剩下的留给
 * 明天。理由是这个任务与在线流量共用同一个数据库 —— 一次清掉几万个用户的
 * 级联删除会长时间持锁，而它带来的收益（磁盘空间）没有任何紧迫性。
 *
 * 积压能否追上：匿名保留期 30 天 + 30 天宽限，也就是每天到期的量约等于
 * 60 天前的日新增匿名用户数。500/天 追不上的话说明日活远超这个量级，
 * 那时该做的是把批量调大或改成按小时跑，而不是让一次任务跑几小时。
 */

/** 15.1：每批 500 */
export const PURGE_BATCH_SIZE = 500;

/** 15.1：`anon_expires_at` 到期后 30 天宽限 */
export const PURGE_GRACE_DAYS = 30;

export interface PurgeDeps {
  readonly retention: RetentionRepository;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly graceDays?: number;
  readonly now?: () => Date;
  /** 排空信号：返回 true 时停止处理后续用户（见 main.ts 的说明） */
  readonly isDraining?: () => boolean;
  /**
   * 导出桶（TP-6-14）。
   *
   * **可缺省**：没有 MinIO 的本地运行仍要能跑清理（与 P3/P4 的同一处理）。
   * 缺省时数据库行照常清理，对象留在桶里 —— 那是可接受的降级，
   * 因为对象最终会被 `users/` 前缀的 90 天生命周期规则回收；
   * 而 `anon/` 前缀没有规则，因此**生产部署必须配置它**
   * （deploy/storage/README.md 有说明）。
   */
  readonly exportStorage?: Pick<ExportStorage, 'delete'>;
}

export interface PurgeSummary {
  readonly scanned: number;
  readonly purged: number;
  readonly failed: number;
  readonly transferred: number;
  /** 因排空而未处理的用户数 */
  readonly skipped: number;
  /** 已删除的导出产物对象数（TP-6-14） */
  readonly objectsDeleted: number;
}

export async function runPurgeRound(deps: PurgeDeps): Promise<PurgeSummary> {
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  const graceDays = deps.graceDays ?? PURGE_GRACE_DAYS;

  const expired = await deps.retention.findExpiredAnonymous({
    limit: batchSize,
    graceDays,
    ...(deps.now === undefined ? {} : { now: deps.now() }),
  });

  let purged = 0;
  let failed = 0;
  let transferred = 0;
  let skipped = 0;
  let objectsDeleted = 0;

  for (const user of expired) {
    if (deps.isDraining?.() === true) {
      /*
       * 排空时停止处理**下一个**用户，而不是中断当前那一个。
       * 当前用户的转存与删除在同一个事务里，中断它只会回滚 ——
       * 不会造成「已删除但未转存」的不可恢复损失（那正是同一事务的用途）。
       */
      skipped = expired.length - purged - failed;
      break;
    }

    try {
      /*
       * TP-6-14 的顺序：先从数据库取出该用户名下产物的真实对象键
       * （R-53：读 `files[].storage_key`，覆盖 15.4 新布局与存量旧布局），
       * 再把删除动作交给 `purgeUser` 在**同一事务内、删行之前**执行。
       *
       * 键必须在事务外先取：`purgeUser` 的 `beforeDelete` 运行时行还在，
       * 但在那里再查一次会多一次往返，而这一次查询与删除之间不存在
       * 「产物被新增」的可能 —— 用户已到期 30 天 + 30 天宽限。
       */
      const keys = await deps.retention.listExportObjectKeys(user.userId);
      const storage = deps.exportStorage;

      const result = await deps.retention.purgeUser(user.userId, async () => {
        if (storage !== undefined) {
          await deleteExportObjects({ storage, logger: deps.logger }, keys);
        }
      });

      purged += 1;
      transferred += result.transferred;
      if (storage !== undefined) objectsDeleted += keys.length;
      anonPurgeTotal.inc({ outcome: 'purged' });
    } catch (error) {
      /*
       * 单个用户失败不中断整批：它下一轮还会被扫到（谓词只看到期时间）。
       * 记 error 级日志 —— 反复失败的同一个用户需要人工介入，
       * 而静默跳过会让它永远留在库里而没人知道。
       *
       * 日志里不带 user_id 之外的任何内容：清理路径上没有必要读用户数据，
       * 因此也不会有任何 L1 内容可以泄漏（二十章）。
       */
      failed += 1;
      anonPurgeTotal.inc({ outcome: 'failed' });
      deps.logger.error({ user_id: user.userId }, `清理匿名用户失败：${String(error)}`);
    }
  }

  /*
   * 21.3 的 `travel_knowledge_rows` 是 Gauge：每轮清理后刷新一次。
   * 用 Gauge 而不是 Counter 是对的 —— 它要回答「知识库累积到多少了」，
   * 而 Counter 只能回答「一共转存过多少次」（进程重启即归零）。
   */
  knowledgeRows.set({}, await deps.retention.countKnowledgeRows());

  deps.logger.info(
    {},
    `保留期清理完成：扫描 ${expired.length} 个到期匿名用户，` +
      `清理 ${purged} 个、转存 ${transferred} 条知识、失败 ${failed} 个` +
      (skipped > 0 ? `、因排空跳过 ${skipped} 个` : ''),
  );

  return { scanned: expired.length, purged, failed, transferred, skipped, objectsDeleted };
}
