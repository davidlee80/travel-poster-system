import { existsSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

interface ProbeRoute {
  readonly dynamic: string;
  readonly revalidate: number;
  GET(): Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('Web 自身健康探针', () => {
  it.each(['healthz', 'readyz'])('/%s 动态返回无缓存的健康结果，不访问上游', async (endpoint) => {
    vi.stubGlobal('fetch', () => {
      throw new Error('探针不应请求 API 或 Redis');
    });
    expect(
      existsSync(new URL(`./${endpoint}/route.ts`, import.meta.url)),
      'Helm 配置的探针必须有对应 Route Handler',
    ).toBe(true);
    const route: ProbeRoute = await import(`./${endpoint}/route.ts`);
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.revalidate).toBe(0);
    const first = route.GET();
    const second = route.GET();
    expect(second).not.toBe(first);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(await first.json()).toEqual({ status: 'ok' });
  });
});
