import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ImageJob {
  readonly strategy: {
    readonly matrix: { readonly include: readonly { name: string; args: string }[] };
  };
  readonly steps: readonly { name?: string; if?: string; run?: string }[];
}

const workflow = parse(
  readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as {
  jobs: { images: ImageJob; shutdown: { env: Record<string, string>; steps: ImageJob['steps'] } };
};

describe('CI 镜像门禁', () => {
  it.each([
    ['api', '3001'],
    ['generation-worker', '3011'],
    ['retention-worker', '3013'],
  ])('%s 的 APP 与 PROBE_PORT 是两个独立 build-args', (name, port) => {
    const entry = workflow.jobs.images.strategy.matrix.include.find((item) => item.name === name);
    // build-push-action v6 的 ignoreComma=true，只按换行拆分。
    expect(entry?.args.trim().split(/\r?\n/)).toEqual([`APP=${name}`, `PROBE_PORT=${port}`]);
  });
  it('恢复协议的真实队列测试进入带 PostgreSQL 和 Redis 的串行 CI 门禁', () => {
    const job = workflow.jobs.shutdown;
    expect(job.env['DATABASE_URL']).toBeTruthy();
    expect(job.env['REDIS_URL']).toBeTruthy();
    const build = job.steps.find((step) => step.name === 'Build')?.run;
    expect(build).toContain('@tps/render-worker...');
    const regression = job.steps.find((step) => step.name === 'P1 生成与导出真实队列恢复')?.run;
    expect(regression).toContain('generation-queue.integration');
    expect(regression).toContain('generation-recovery.integration');
    expect(regression).toContain('--no-file-parallelism');
    expect(regression).toContain('pnpm --filter @tps/render-worker run test:integration');
  });

  it.each(['NODE_ENV', 'SMS_MODE'])('共享部署保留环境文件对 %s 的控制权', (key) => {
    const compose = parse(
      readFileSync(new URL('../../../deploy/mvp-apps.yml', import.meta.url), 'utf8'),
    ) as { services: { api: { environment: Record<string, string> } } };
    expect(compose.services.api.environment).not.toHaveProperty(key);
  });

  it('Web 镜像必须实际请求两个探针', () => {
    const step = workflow.jobs.images.steps.find((item) => item.name === '验证 Web 健康探针');
    expect(step?.if).toBe("matrix.name == 'web'");
    expect(step?.run).toContain('docker run');
    expect(step?.run).toContain('/healthz');
    expect(step?.run).toContain('/readyz');
    expect(step?.run).toContain('fetch(');
  });
});
