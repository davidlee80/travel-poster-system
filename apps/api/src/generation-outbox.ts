import type { GenerationOutboxRepository } from '@tps/db';
import type { PlanQueue } from '@tps/queue';
import type { Logger } from '@tps/shared';
import { createGauge } from '@tps/observability';

const pendingGauge = createGauge({
  name: 'travel_generation_outbox_pending',
  help: '生成待投递任务数',
});
const oldestGauge = createGauge({
  name: 'travel_generation_outbox_oldest_seconds',
  help: '最老待投递生成任务等待秒数',
});

export interface GenerationOutboxDeps {
  readonly outbox: GenerationOutboxRepository;
  readonly queue: Pick<PlanQueue, 'enqueue'>;
  readonly logger: Logger;
  readonly releaseFailed: (jobId: string) => Promise<void>;
}

async function enqueueWithDeadline(work: Promise<string>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OUTBOX_ENQUEUE_TIMEOUT')), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function dispatchGenerationOutbox(deps: GenerationOutboxDeps): Promise<void> {
  try {
    const claims = await deps.outbox.claim();
    // 同批并行：20 条串行各等 5 秒会超过 30 秒租约。
    await Promise.all(
      claims.map(async (claim) => {
        try {
          const prepared = await deps.outbox.prepare(claim);
          if (prepared.kind === 'deliver')
            await enqueueWithDeadline(deps.queue.enqueue(prepared.payload));
          if (prepared.kind === 'release') await deps.releaseFailed(prepared.jobId);
          await deps.outbox.acknowledge(claim);
        } catch (error) {
          deps.logger.warn(
            {
              job_id: claim.jobId,
              attempts: claim.attempts,
              reason_code: 'OUTBOX_DELIVERY_FAILED',
              err: error,
            },
            '生成投递未确认，保留任务并重试',
          );
          // 重排也失败时不丢任务，数据库租约到期后下轮重新领取。
          await deps.outbox.retry(claim).catch((retryError: unknown) => {
            deps.logger.warn(
              { job_id: claim.jobId, err: retryError },
              'Outbox 重排失败，等待租约到期',
            );
          });
        }
      }),
    );
    const stats = await deps.outbox.stats();
    pendingGauge.set({}, stats.pending);
    oldestGauge.set({}, stats.oldestSeconds);
  } catch (error) {
    deps.logger.warn(
      { err: error, reason_code: 'OUTBOX_SCAN_FAILED' },
      'Outbox 扫描失败，下轮继续',
    );
  }
}

/** 不重叠扫描；停机返回的 Promise 完成前不能关闭队列和连接池。 */
export function startGenerationOutbox(deps: GenerationOutboxDeps): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const tick = (): void => {
    running = dispatchGenerationOutbox(deps).finally(() => {
      if (!stopped) {
        timer = setTimeout(tick, 1000);
        timer.unref();
      }
    });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await running;
  };
}
