import type { LedgerEntry } from '@tps/db';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_GRANT_CR,
  formatEntry,
  normalizePhone,
  parseArgs,
} from './user-credit-cli.js';

/**
 * `pnpm user:credit` 的参数解析（C-5）。
 *
 * 两条最要紧：
 *
 * 1. **手机号要归一成 E.164**。库里存的是 `+8613800000000`，不归一的话
 *    `--phone 13800000000` 查不到任何人 —— 而那看起来像「这个用户不存在」。
 * 2. **大额授予要显式确认**。`--grant 9900000` 与 `--grant 9900` 差一个手滑，
 *    而多授出去的 CR 没有撤销入口（流水只追加，`credit()` 只收正数）。
 */

describe('parseArgs', () => {
  it('只给邮箱是查询', () => {
    expect(parseArgs(['--email', 'a@b.com'])).toEqual({
      kind: 'show',
      lookup: { by: 'email', value: 'a@b.com' },
      limit: DEFAULT_HISTORY_LIMIT,
    });
  });

  it('手机号被归一成 E.164', () => {
    expect(parseArgs(['--phone', '13800000000'])).toMatchObject({
      lookup: { by: 'phone', value: '+8613800000000' },
    });
    expect(parseArgs(['--phone', '+8613800000000'])).toMatchObject({
      lookup: { by: 'phone', value: '+8613800000000' },
    });
  });

  it('带 --grant 是授予，可带备注', () => {
    expect(parseArgs(['--email', 'a@b.com', '--grant', '9900', '--note', '工单 123'])).toEqual({
      kind: 'grant',
      lookup: { by: 'email', value: 'a@b.com' },
      amountCr: 9_900,
      note: '工单 123',
      limit: DEFAULT_HISTORY_LIMIT,
    });
  });

  it('--email 与 --phone 不能同时给', () => {
    /* 同时给必然有一个被忽略，而被忽略的那个正是人以为在用的那个 */
    expect(() => parseArgs(['--email', 'a@b.com', '--phone', '13800000000'])).toThrow(
      /不能同时使用/,
    );
  });

  it('两个都不给时报错，而不是查一个空用户', () => {
    expect(() => parseArgs(['--grant', '100'])).toThrow(/--email|--phone/);
  });

  it('超过上限的授予被拒，加 --force 放行', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--grant', String(MAX_GRANT_CR + 1)])).toThrow(
      /--force/,
    );
    expect(
      parseArgs(['--email', 'a@b.com', '--grant', String(MAX_GRANT_CR + 1), '--force']),
    ).toMatchObject({ amountCr: MAX_GRANT_CR + 1 });
  });

  it('--force 是无值开关，放在别的选项前面也能解析', () => {
    /*
     * `--force --grant 9900` 里 `--force` 的下一个 token 以 `--` 开头。
     * 按「每个 flag 都要有值」解析会报「--force 缺少取值」，
     * 而人只会觉得这个命令的参数顺序莫名其妙。
     */
    expect(parseArgs(['--force', '--email', 'a@b.com', '--grant', '9900'])).toMatchObject({
      kind: 'grant',
      amountCr: 9_900,
    });
  });

  it('授予额必须是正整数 CR', () => {
    /* `9.9` 看起来像「9.9 元」—— 拒掉它，别让人以为自己在用元 */
    expect(() => parseArgs(['--email', 'a@b.com', '--grant', '9.9'])).toThrow(/正整数/);
    expect(() => parseArgs(['--email', 'a@b.com', '--grant', '0'])).toThrow(/正整数/);
    expect(() => parseArgs(['--email', 'a@b.com', '--grant', '-100'])).toThrow(/正整数/);
  });

  it('裸 -- 被忽略（pnpm 的参数分隔符会原样透传）', () => {
    expect(parseArgs(['--', '--email', 'a@b.com'])).toMatchObject({ kind: 'show' });
  });

  it('--limit 非法时报错', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--limit', '0'])).toThrow(/--limit/);
  });
});

describe('normalizePhone', () => {
  it('拒掉不是手机号的输入', () => {
    expect(() => normalizePhone('12345')).toThrow(/手机号/);
    expect(() => normalizePhone('10000000000')).toThrow(/手机号/);
  });
});

describe('formatEntry', () => {
  const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
    entryId: 'e1',
    kind: 'GRANT',
    amountCr: 9_900,
    balanceAfterCr: 9_900,
    refType: 'SIGNUP',
    refId: 'user-1',
    priceVersion: null,
    createdAt: '2026-04-01T10:00:00.000Z',
    metadata: {},
    ...overrides,
  });

  it('进账带 + 号，消费带 -（方向靠符号本身表达）', () => {
    expect(formatEntry(entry())).toContain('+9900');
    expect(formatEntry(entry({ kind: 'SPEND', amountCr: -1_220 }))).toContain('-1220');
  });

  it('没有 ref 的行不留下尾随空格', () => {
    const line = formatEntry(entry({ kind: 'ADJUST', refType: null, refId: null }));
    expect(line).toBe(line.trimEnd());
  });
});
