import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { renderPage } from './render-page.js';

vi.mock('./page-checks.js', () => ({
  waitForReady: () => Promise.resolve(),
  probeCjkGlyphs: () => Promise.resolve({ subsetLoaded: true, bodyUsesSubset: true }),
  countMissingIcons: () => Promise.resolve(0),
  countBrokenImages: () => Promise.resolve({ total: 0, broken: 0 }),
  detectOverflow: () => Promise.resolve({ canvasOverflowX: false, violations: [] }),
}));

it('渲染令牌只发往指定主文档，且不自动跟随携令牌重定向', async () => {
  let intercept: ((route: Route) => Promise<void>) | undefined;
  let globalHeaders: Record<string, string> = {};
  const mainFrame = {};
  const emitted: { headers: Record<string, string>; maxRedirects?: number }[] = [];
  const targets = [
    { url: 'http://web:3000/render/plans/p/days/1?compact=1', type: 'document', main: true },
    { url: 'https://cdn.test/photo.png', type: 'image', main: true },
    { url: 'http://web:3000/render/plans/p/days/2', type: 'document', main: true },
    { url: 'http://web:3000/render/plans/p/days/1', type: 'fetch', main: true },
    { url: 'http://web:3000/render/plans/p/days/1', type: 'document', main: false },
    { url: 'https://cdn.test/redirected', type: 'document', main: true },
  ];
  const page = {
    mainFrame: () => mainFrame,
    setExtraHTTPHeaders: (headers: Record<string, string>) => {
      globalHeaders = headers;
      return Promise.resolve();
    },
    route: (_pattern: string, handler: typeof intercept) => {
      intercept = handler;
      return Promise.resolve();
    },
    goto: async () => {
      for (const target of targets) {
        if (intercept === undefined) {
          emitted.push({ headers: globalHeaders });
          continue;
        }
        const request = {
          url: () => target.url,
          method: () => 'GET',
          resourceType: () => target.type,
          isNavigationRequest: () => target.type === 'document',
          frame: () => (target.main ? mainFrame : {}),
          headers: () => ({ accept: '*/*', 'x-render-token': 'stale' }),
        };
        await intercept({
          request: () => request,
          continue: (options: { headers: Record<string, string> }) => {
            emitted.push(options);
            return Promise.resolve();
          },
          fetch: (options: { headers: Record<string, string>; maxRedirects: number }) => {
            emitted.push(options);
            return Promise.resolve({});
          },
          fulfill: () => Promise.resolve(),
        } as unknown as Route);
      }
    },
    close: () => Promise.resolve(),
  } as unknown as Page;
  await renderPage({
    context: { newPage: () => Promise.resolve(page) } as BrowserContext,
    baseUrl: 'http://web:3000',
    path: '/render/plans/p/days/1',
    renderToken: 'page-secret',
    templateId: 'ink-grid',
  });
  expect(emitted[0]).toMatchObject({
    headers: { 'x-render-token': 'page-secret' },
    maxRedirects: 0,
  });
  for (const request of emitted.slice(1))
    expect(request.headers).not.toHaveProperty('x-render-token');
});

describe('令牌拦截安装失败', () => {
  it('关闭已创建页面，避免浏览器资源泄漏', async () => {
    const close = vi.fn(() => Promise.resolve());
    const fail = () => Promise.reject(new Error('route setup failed'));
    const page = { route: fail, setExtraHTTPHeaders: fail, close } as unknown as Page;
    await expect(
      renderPage({
        context: { newPage: () => Promise.resolve(page) } as BrowserContext,
        baseUrl: 'http://web:3000',
        path: '/render/plans/p/full',
        renderToken: 'secret',
        templateId: 'ink-grid',
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});
