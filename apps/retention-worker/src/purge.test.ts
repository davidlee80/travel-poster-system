import type { ExpiredAnonymousUser, PurgeUserResult, RetentionRepository } from '@tps/db';
import { createSilentLogger } from '@tps/shared';
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
}

function fake(options: FakeOptions = {}): {
  repository: RetentionRepository;
  purged: string[];
  scans: { limit: number; graceDays: number }[];
} {
  const purged: string[] = [];
  const scans: { limit: number; graceDays: number }[] = [];
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
    purgeUser: (userId): Promise<PurgeUserResult> => {
      if (failing.has(userId)) return Promise.reject(new Error('级联删除失败'));
      purged.push(userId);
      return Promise.resolve({
        userId,
        transferred: options.transferredPerUser ?? 1,
        deleted: true,
      });
    },
    countKnowledgeRows: () => Promise.resolve(purged.length * (options.transferredPerUser ?? 1)),
  };

  return { repository, purged, scans };
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
