import { describe, expect, it } from 'vitest';

import {
  DLQ_KEY_PREFIX,
  DLQ_MAX_ENTRIES,
  InMemoryDeadLetterQueue,
  type DeadLetterEntry,
} from './dlq.js';

/**
 * 死信队列（TP-4-11，13.7「耗尽进入死信队列 `dlq:*`」）。
 *
 * 这里测的是**语义**（最新优先、上限截断），Redis 侧的 LPUSH/LTRIM 行为由
 * 集成测试覆盖。
 */

function entry(jobId: string): DeadLetterEntry {
  return {
    jobId,
    requestId: `request-${jobId}`,
    planId: `plan-${jobId}`,
    userId: 'user-1',
    errorCode: 'PLAN_LLM_UNAVAILABLE',
    attemptsMade: 3,
    failedAt: '2026-08-18T10:00:00.000Z',
  };
}

describe('死信队列', () => {
  it('最新的在前 —— 回捞要看的是正在排查的那一批', async () => {
    const dlq = new InMemoryDeadLetterQueue();
    await dlq.push('q', entry('a'));
    await dlq.push('q', entry('b'));

    const entries = await dlq.peek('q', 10);
    expect(entries.map((item) => item.jobId)).toEqual(['b', 'a']);
  });

  it('按队列名隔离', async () => {
    const dlq = new InMemoryDeadLetterQueue();
    await dlq.push('q1', entry('a'));
    expect(await dlq.size('q2')).toBe(0);
  });

  it('超出上限时丢弃最旧的（Redis 是内存存储）', async () => {
    const dlq = new InMemoryDeadLetterQueue();
    for (let i = 0; i < DLQ_MAX_ENTRIES + 5; i += 1) {
      await dlq.push('q', entry(`job-${i}`));
    }

    expect(await dlq.size('q')).toBe(DLQ_MAX_ENTRIES);
    const [newest] = await dlq.peek('q', 1);
    expect(newest?.jobId).toBe(`job-${DLQ_MAX_ENTRIES + 4}`);
  });

  it('条目只含标识符与失败原因，不含请求体（Redis 不留个人数据副本）', async () => {
    const dlq = new InMemoryDeadLetterQueue();
    await dlq.push('q', entry('a'));
    const [item] = await dlq.peek('q', 1);

    expect(Object.keys(item ?? {}).sort()).toEqual([
      'attemptsMade',
      'errorCode',
      'failedAt',
      'jobId',
      'planId',
      'requestId',
      'userId',
    ]);
  });

  it('键前缀与 13.7 的 `dlq:*` 一致', () => {
    expect(DLQ_KEY_PREFIX).toBe('dlq:');
  });
});
