import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { creditHint } from '@/lib/credits';
import type { CreditQuoteResponse } from '@/lib/api-client';

import { CreditHint } from './CreditHint';

/**
 * 报价提示的渲染产物（C-6）。
 *
 * 文案本身由 `lib/credits.test.ts` 覆盖。这里盯的是两件只在标记里成立的事：
 * 余额不足时带 `role="alert"`（读屏软件要念出来）与 `--warn` 类
 * （窄屏吸底条隐藏了普通辅助文字，只有这个类的规则把它留下来 ——
 * 而它解释的正是「按钮为什么点不了」）。
 */

function quote(overrides: Partial<CreditQuoteResponse> = {}): CreditQuoteResponse {
  return {
    price_version: 1,
    typical_cr: 2_475,
    ceiling_cr: 5_041,
    hold_cr: 2_970,
    typical_cny: '2.48',
    ceiling_cny: '5.04',
    balance_cr: 9_900,
    held_cr: 0,
    sufficient: true,
    ...overrides,
  };
}

describe('CreditHint', () => {
  it('不计费时一个节点都不渲染', () => {
    expect(renderToStaticMarkup(<CreditHint hint={creditHint(null)} />)).toBe('');
  });

  it('够用时是普通辅助文字，不带 alert', () => {
    const html = renderToStaticMarkup(<CreditHint hint={creditHint(quote())} />);
    expect(html).toContain('2475 CR');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('--warn');
  });

  it('余额不足时带 alert 与 --warn 类', () => {
    const html = renderToStaticMarkup(
      <CreditHint hint={creditHint(quote({ balance_cr: 1_200, sufficient: false }))} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('planner-actions__note--warn');
    expect(html).toContain('还差 1770 CR');
  });
});
