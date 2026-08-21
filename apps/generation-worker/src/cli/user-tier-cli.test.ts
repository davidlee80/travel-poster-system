import { describe, expect, it } from 'vitest';

import { DEFAULT_LIST_LIMIT, formatUser, parseArgs } from './user-tier-cli.js';

/**
 * `pnpm user:tier` 的参数解析（多模型 failover 计划的任务 5）。
 *
 * 最重要的一条是**负数在 CLI 就被拒**。数据库的 `users_tier_level_check`
 * 也会拒，但它的报文是 `violates check constraint "users_tier_level_check"`
 * —— 对着终端的人得先去翻迁移文件才知道自己错在哪。
 */

describe('parseArgs', () => {
  it('只给邮箱是查询', () => {
    expect(parseArgs(['--email', 'a@b.com'])).toEqual({ kind: 'show', email: 'a@b.com' });
  });

  it('带 --set 是设置', () => {
    expect(parseArgs(['--email', 'a@b.com', '--set', '10'])).toEqual({
      kind: 'set',
      email: 'a@b.com',
      tierLevel: 10,
    });
  });

  it('--set 0 是合法的（降级回默认档）', () => {
    /*
     * 0 是默认档，把用户设回 0 是真实的运营操作（退订）。
     * 用 `!value` 之类的判空会把它当成「没给」，表现是退订静默无效。
     */
    expect(parseArgs(['--email', 'a@b.com', '--set', '0'])).toMatchObject({ tierLevel: 0 });
  });

  it('--list 是按档列出，limit 有默认值', () => {
    expect(parseArgs(['--list', '10'])).toEqual({
      kind: 'list',
      tierLevel: 10,
      limit: DEFAULT_LIST_LIMIT,
    });
  });

  it('忽略 pnpm 透传的裸 --', () => {
    expect(parseArgs(['--', '--email', 'a@b.com'])).toEqual({ kind: 'show', email: 'a@b.com' });
  });

  it('--set 负数被拒，报文说明要非负整数', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--set', '-1'])).toThrow(/非负整数/);
  });

  it('--set 小数被拒（等级是整数档位）', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--set', '1.5'])).toThrow(/非负整数/);
  });

  it('两个动作都不给时报错，而不是静默什么都不做', () => {
    expect(() => parseArgs([])).toThrow(/--email|--list/);
  });

  it('--email 与 --list 同时给时报错（否则有一个被静默忽略）', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--list', '10'])).toThrow(/不能同时/);
  });

  it('选项缺取值时报错', () => {
    expect(() => parseArgs(['--email'])).toThrow(/缺少取值/);
  });
});

describe('formatUser', () => {
  it('一行带等级、邮箱、ID 与身份类型', () => {
    const line = formatUser({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.com',
      userType: 'REGISTERED',
      tierLevel: 10,
    });

    expect(line).toContain('tier');
    expect(line).toContain('10');
    expect(line).toContain('a@b.com');
    expect(line).toContain('REGISTERED');
  });

  it('匿名用户没有邮箱时显示占位而不是 null', () => {
    const line = formatUser({
      userId: 'x',
      email: null,
      userType: 'ANONYMOUS',
      tierLevel: 0,
    });
    expect(line).toContain('(匿名)');
    expect(line).not.toContain('null');
  });
});
