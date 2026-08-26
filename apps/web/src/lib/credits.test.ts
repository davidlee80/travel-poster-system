import { describe, expect, it } from 'vitest';

import type { CreditQuoteResponse, LedgerEntryView } from './api-client.js';
import { creditHint, entryTime, ledgerKindLabel, signedCr, visibleEntries } from './credits.js';

/**
 * CR 的界面呈现（C-6）。
 *
 * 这一层装的全是「用户会读到的那句话」，而那句话错了没有任何断言会红：
 * 把「还差多少」算反、金额少一个负号、余额不足时却说「预计消耗」——
 * 三者都只会在生产上被用户发现。
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

describe('creditHint', () => {
  it('够用时给出预计、上界与余额', () => {
    const hint = creditHint(quote());
    expect(hint.kind).toBe('ok');
    expect(hint.text).toContain('2475 CR');
    expect(hint.text).toContain('2.48 元');
    /* 上界一并给出：只给「预计」的话，一次落在上界附近的生成会像被多扣了 */
    expect(hint.detail).toContain('5041');
    expect(hint.detail).toContain('9900');
    expect(hint.shortfallCr).toBe(0);
  });

  it('不够时算出还差多少，并且措辞是「余额不足」', () => {
    const hint = creditHint(quote({ balance_cr: 1_200, sufficient: false }));
    expect(hint.kind).toBe('insufficient');
    expect(hint.shortfallCr).toBe(2_970 - 1_200);
    expect(hint.text).toContain('还差 1770 CR');
    /* 不能同时说「预计消耗」——那句读起来像「可以生成」 */
    expect(hint.text).not.toContain('预计');
  });

  it('「够不够」只认服务端的 sufficient，不自己比', () => {
    /*
     * 余额看起来够（9900 > 2970）但服务端说不够 —— 这种组合在真实系统里
     * 会出现（两次请求之间余额被另一个并发任务冻走了）。自己比一遍的表现是
     * **「按钮说够、提交被拒」**，而用户看到的只有一个 402。
     */
    expect(creditHint(quote({ sufficient: false })).kind).toBe('insufficient');
    /* 反过来也一样：服务端说够就是够 */
    expect(creditHint(quote({ balance_cr: 0, sufficient: true })).kind).toBe('ok');
  });

  it('没有报价、或不计费时什么都不显示', () => {
    expect(creditHint(null).kind).toBe('hidden');
    /*
     * `price_version === null` = 一版价目表都没发布，这次不收费。
     * 显示「本次免费」会让人以为是优惠活动，下次收费时就成了背信。
     */
    expect(creditHint(quote({ price_version: null })).kind).toBe('hidden');
    expect(creditHint(quote({ hold_cr: 0 })).kind).toBe('hidden');
  });
});

describe('流水呈现', () => {
  const entry = (overrides: Partial<LedgerEntryView> = {}): LedgerEntryView => ({
    entry_id: 'e1',
    kind: 'SPEND',
    amount_cr: -1_220,
    balance_after_cr: 8_680,
    ref_type: 'JOB',
    ref_id: 'job-1',
    created_at: '2026-04-01T10:30:00.000Z',
    ...overrides,
  });

  it('金额带符号，进账为正', () => {
    expect(signedCr(-1_220)).toBe('-1220 CR');
    expect(signedCr(9_900)).toBe('+9900 CR');
  });

  it('六种 kind 都有中文，未知的原样显示', () => {
    expect(ledgerKindLabel('SPEND')).toBe('消费');
    expect(ledgerKindLabel('GRANT')).toBe('赠送');
    expect(ledgerKindLabel('REFUND')).toBe('退回');
    /* 新增一种流水时界面不该显示「undefined」 */
    expect(ledgerKindLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('坏账行不展示给用户', () => {
    /*
     * `WRITE_OFF` 记的是我们烧掉的成本，金额恒 0，真实数字在不下发的
     * `metadata` 里。留着它的表现是用户看到几行「成本记账 0」——
     * 既看不懂，也无从判断那是不是错账。
     */
    const rows = visibleEntries([
      entry(),
      entry({ entry_id: 'e2', kind: 'WRITE_OFF', amount_cr: 0 }),
    ]);
    expect(rows.map((row) => row.entry_id)).toEqual(['e1']);
  });

  it('时间格式非法时原样返回，而不是显示 Invalid Date', () => {
    expect(entryTime('不是时间')).toBe('不是时间');
    /* 合法输入按本地时区到分钟 —— 只断言形状，不断言时区 */
    expect(entryTime('2026-04-01T10:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
