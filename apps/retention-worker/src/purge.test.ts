import type { ExpiredAnonymousUser, PurgeUserResult, RetentionRepository } from '@tps/db';
import { createSilentLogger } from '@tps/shared';
import { InMemoryExportStorage } from '@tps/storage';
import { describe, expect, it } from 'vitest';

import { PURGE_BATCH_SIZE, PURGE_GRACE_DAYS, runPurgeRound } from './purge.js';

/**
 * 保留期清理的一轮（TP-4-21，设计稿 15.1）。
 *
 * SQL 侧（转存 + 级联删除同一事务）由 `@tps/db` 的集成测试覆盖。
 * 这里测的是**编排**：批量、单个失败不中断、排空时停在用户边界。
 */

interface FakeOptions {
  readonly users?: readonly string[];
  /** 这些用户的 purgeUser 会抛错 */
  readonly failing?: readonly string[];
  readonly transferredPerUser?: number;
  /** 每个用户名下的导出产物对象键（TP-6-14） */
  readonly objectKeys?: Record<string, readonly string[]>;
}

function fake(options: FakeOptions = {}): {
  repository: RetentionRepository;
  purged: string[];
  scans: { limit: number; graceDays: number }[];
  /** 每个用户的调用顺序：'objects' 在 'delete-row' 之前才算对（TP-6-14） */
  order: string[];
} {
  const purged: string[] = [];
  const scans: { limit: number; graceDays: number }[] = [];
  const order: string[] = [];
  const failing = new Set(options.failing ?? []);

  const repository: RetentionRepository = {
    findExpiredAnonymous: (input) => {
      scans.push({ limit: input.limit, graceDays: input.graceDays });
      return Promise.resolve(
        (options.users ?? []).map((userId): ExpiredAnonymousUser => ({
          userId,
          anonExpiresAt: new Date('2026-06-01T00:00:00Z'),
        })),
      );
    },
    listExportObjectKeys: (userId) => Promise.resolve(options.objectKeys?.[userId] ?? []),
    purgeUser: async (userId, beforeDelete): Promise<PurgeUserResult> => {
      /*
       * 假实现模拟真实的事务顺序：beforeDelete 先跑，它抛错则整体失败
       * 且**不记入 purged**（真实实现是事务回滚，行保留）。
       */
      if (beforeDelete !== undefined) {
        await beforeDelete();
        order.push(`objects:${userId}`);
      }
      if (failing.has(userId)) throw new Error('级联删除失败');
      order.push(`delete-row:${userId}`);
      purged.push(userId);
      return {
        userId,
        transferred: options.transferredPerUser ?? 1,
        deleted: true,
      };
    },
    countKnowledgeRows: () => Promise.resolve(purged.length * (options.transferredPerUser ?? 1)),
  };

  return { repository, purged, scans, order };
}

describe('批量与默认值', () => {
  it('15.1：每批 500、宽限 30 天', async () => {
    expect(PURGE_BATCH_SIZE).toBe(500);
    expect(PURGE_GRACE_DAYS).toBe(30);

    const { repository, scans } = fake();
    await runPurgeRound({ retention: repository, logger: createSilentLogger() });

    expect(scans).toEqual([{ limit: 500, graceDays: 30 }]);
  });

  it('一轮只扫一批 —— 剩下的留给明天（不与在线流量抢数据库）', async () => {
    const { repository, scans } = fake({ users: ['u1', 'u2'] });
    await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      batchSize: 2,
    });
    expect(scans).toHaveLength(1);
  });

  it('没有到期用户时什么都不做', async () => {
    const { repository, purged } = fake({ users: [] });
    const summary = await runPurgeRound({ retention: repository, logger: createSilentLogger() });

    expect(purged).toEqual([]);
    expect(summary).toMatchObject({ scanned: 0, purged: 0, failed: 0 });
  });
});

describe('单个失败不中断整批', () => {
  it('失败的用户被跳过，其余照常清理', async () => {
    /*
     * 500 个用户放一个事务里删的话，任何一个失败就整批回滚 ——
     * 而一个用户的级联删除会碰到十几张表，失败面不小。
     */
    const { repository, purged } = fake({
      users: ['u1', 'u2', 'u3'],
      failing: ['u2'],
    });

    const summary = await runPurgeRound({ retention: repository, logger: createSilentLogger() });

    expect(purged).toEqual(['u1', 'u3']);
    expect(summary).toMatchObject({ scanned: 3, purged: 2, failed: 1 });
  });

  it('失败的用户下一轮还会被扫到（谓词只看到期时间）', async () => {
    const { repository, scans } = fake({ users: ['u1'], failing: ['u1'] });
    await runPurgeRound({ retention: repository, logger: createSilentLogger() });
    await runPurgeRound({ retention: repository, logger: createSilentLogger() });
    // 两轮都用同样的谓词扫描 —— 没有「跳过失败用户」的黑名单
    expect(scans).toHaveLength(2);
    expect(scans[0]).toEqual(scans[1]);
  });
});

describe('排空', () => {
  it('停在用户边界，不中断正在跑的那一个', async () => {
    const { repository, purged } = fake({ users: ['u1', 'u2', 'u3'] });
    let processed = 0;

    const summary = await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      isDraining: () => {
        // 第一个用户处理完之后开始排空
        const draining = processed >= 1;
        processed += 1;
        return draining;
      },
    });

    /*
     * 第一次检查（处理 u1 前）返回 false，第二次（处理 u2 前）返回 true。
     * 因此只清了 u1，u2/u3 留给下一轮 —— 而它们下一轮仍会被扫到。
     */
    expect(purged).toEqual(['u1']);
    expect(summary.skipped).toBe(2);
  });
});

describe('转存计数', () => {
  it('汇总每个用户转存的知识条数（TP-4-22）', async () => {
    const { repository } = fake({ users: ['u1', 'u2'], transferredPerUser: 3 });
    const summary = await runPurgeRound({ retention: repository, logger: createSilentLogger() });
    expect(summary.transferred).toBe(6);
  });
});

describe('对象存储清理（TP-6-14，门禁 #38）', () => {
  it('删对象在删行之前', async () => {
    /*
     * 顺序是 TP-6-14 的硬约束：行先删则 exports.files[].storage_key 随之
     * 消失，而那是唯一能推出对象键的地方 —— 产物成为永久孤儿，
     * 且因为 anon/ 前缀禁挂生命周期规则（R-50），它们永远不会过期。
     */
    const { repository, order } = fake({
      users: ['u1'],
      objectKeys: { u1: ['anon/202608/c1/exports/e1/day-01.png'] },
    });
    const storage = new InMemoryExportStorage();
    storage.objects.set('anon/202608/c1/exports/e1/day-01.png', {
      body: new Uint8Array(),
      contentType: 'image/png',
    });

    await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      exportStorage: storage,
    });

    expect(order).toEqual(['objects:u1', 'delete-row:u1']);
    expect(storage.objects.size).toBe(0);
  });

  it('删对象失败则**行保留**（下一轮重试）', async () => {
    const { repository, purged } = fake({
      users: ['u1'],
      objectKeys: { u1: ['anon/202608/c1/exports/e1/day-01.png'] },
    });
    const failingStorage = {
      delete: () => Promise.reject(new Error('S3 5xx')),
    };

    const summary = await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      exportStorage: failingStorage,
    });

    expect(purged).toEqual([]);
    expect(summary).toMatchObject({ scanned: 1, purged: 0, failed: 1 });
  });

  it('没有产物的用户照常清理，不调用 delete', async () => {
    const { repository, purged } = fake({ users: ['u1'] });
    const storage = new InMemoryExportStorage();

    await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      exportStorage: storage,
    });

    expect(purged).toEqual(['u1']);
    expect(storage.counts.delete).toBe(0);
  });

  it('未配置导出桶时清理照常完成（本地无 MinIO 的降级）', async () => {
    const { repository, purged } = fake({
      users: ['u1'],
      objectKeys: { u1: ['anon/202608/c1/exports/e1/day-01.png'] },
    });

    const summary = await runPurgeRound({ retention: repository, logger: createSilentLogger() });

    expect(purged).toEqual(['u1']);
    expect(summary.objectsDeleted).toBe(0);
  });

  it('objectsDeleted 汇总删除的对象数', async () => {
    const { repository } = fake({
      users: ['u1', 'u2'],
      objectKeys: {
        u1: ['anon/202608/c1/exports/e1/day-01.png', 'anon/202608/c1/exports/e1/day-02.png'],
        u2: ['users/u2/202608/c2/exports/e2/plan.pdf'],
      },
    });
    const storage = new InMemoryExportStorage();

    const summary = await runPurgeRound({
      retention: repository,
      logger: createSilentLogger(),
      exportStorage: storage,
    });

    expect(summary.objectsDeleted).toBe(3);
  });

  it('ExportStorage 接口上不存在任何按前缀删除的方法（R-50 的硬约束）', () => {
    /*
     * 类型层面已经保证（接口里没有 deletePrefix），但类型只在编译期存在。
     * 这一条是运行期的兜底断言 —— 它拦的是「有人加了一个 deletePrefix
     * 但忘了它为什么不该存在」。
     */
    const storage = new InMemoryExportStorage();
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(storage));

    expect(names.filter((name) => /prefix/i.test(name))).toEqual([]);
    expect(names).toContain('delete');
  });
});
