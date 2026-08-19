import { randomUUID } from 'node:crypto';

import { uuidv7 } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMIT, formatRow, parseArgs, toQuery } from './content-cli.js';

/**
 * `pnpm content:find` 的参数解析与输出（TP-6-16）。
 *
 * SQL 侧由 `packages/db` 的 `content-find.integration.test.ts` 覆盖。
 * 这里验证的是 CLI 层：三种查询形态各自转成什么查询、日期怎么解释、
 * 输出里有没有存储前缀。
 */

describe('parseArgs', () => {
  it('按 content-id 查', () => {
    const id = uuidv7();
    expect(parseArgs(['--content-id', id])).toMatchObject({ contentId: id, userId: null });
  });

  it('按 user + 时间范围查', () => {
    const args = parseArgs(['--user', 'u-1', '--from', '2026-08-01', '--to', '2026-09-01']);

    expect(args.userId).toBe('u-1');
    expect(args.from?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(args.to?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('只按时间范围 + status 查', () => {
    const args = parseArgs(['--from', '2026-08-01', '--to', '2026-09-01', '--status', 'REJECTED']);
    expect(args).toMatchObject({ contentId: null, userId: null, status: 'REJECTED' });
  });

  it('limit 缺省为 20', () => {
    expect(parseArgs(['--user', 'u-1']).limit).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBe(20);
  });

  it('limit 非法被拒', () => {
    expect(() => parseArgs(['--user', 'u-1', '--limit', '0'])).toThrow(/limit/);
    expect(() => parseArgs(['--user', 'u-1', '--limit', 'abc'])).toThrow(/limit/);
  });

  it('忽略 pnpm 透传的裸 --（否则它会吞掉第一个选项）', () => {
    /*
     * `pnpm content:find -- --user u-1` 的 argv 里真的有一个裸 `--`。
     * 不忽略的话它被当成名为空串的选项并吞掉 `--user`，
     * 表现是「选项 -- 缺少取值」—— 一条让人完全查不到方向的错误。
     */
    expect(parseArgs(['--', '--user', 'u-1']).userId).toBe('u-1');
  });

  it('选项缺值时抛错，而不是把下一个选项当成取值', () => {
    /*
     * `--user --from 2026-08-01` 这种打错会让 userId 变成 '--from'，
     * 然后查出零行 —— 而运维会以为「这个用户没有内容」。
     */
    expect(() => parseArgs(['--user', '--from', '2026-08-01'])).toThrow(/缺少取值/);
  });

  it('日期只接受 YYYY-MM-DD 或 ISO 8601，按 UTC 解释', () => {
    /*
     * `new Date('2026/08/01')` 是**本地时区**午夜。接受它会让同一条命令在
     * 不同 TZ 的机器上查出不同区间，而 15.4 的路径与 UUIDv7 的时间前缀
     * 都是 UTC。
     */
    expect(() => parseArgs(['--from', '2026/08/01'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--from', 'yesterday'])).toThrow(/YYYY-MM-DD/);
    expect(parseArgs(['--from', '2026-08-01T12:30:00Z']).from?.toISOString()).toBe(
      '2026-08-01T12:30:00.000Z',
    );
  });
});

describe('toQuery', () => {
  it('null 字段不进查询对象（exactOptionalPropertyTypes）', () => {
    const query = toQuery(parseArgs(['--user', 'u-1']));
    expect(Object.keys(query).sort()).toEqual(['limit', 'userId']);
  });

  it('全部维度都给时一并带上', () => {
    const query = toQuery(
      parseArgs([
        '--content-id',
        'c-1',
        '--user',
        'u-1',
        '--from',
        '2026-08-01',
        '--to',
        '2026-09-01',
        '--status',
        'READY',
      ]),
    );
    expect(Object.keys(query).sort()).toEqual([
      'contentId',
      'from',
      'limit',
      'status',
      'to',
      'userId',
    ]);
  });
});

describe('formatRow', () => {
  const base = {
    planId: 'p-1',
    userId: 'u-1',
    userStatus: 'ACTIVE',
    versionStatus: 'READY',
    createdAt: new Date('2026-08-19T08:00:00Z'),
    destinationPlaceId: 'cn-hangzhou',
    totalDays: 5,
    jobIds: ['j-1'],
    exportIds: ['e-1'],
  };

  it('注册用户的存储前缀走 users/', () => {
    const contentId = uuidv7(Date.UTC(2026, 7, 19));
    const text = formatRow({ ...base, contentId, userType: 'REGISTERED' });

    expect(text).toContain(`存储前缀   users/u-1/202608/${contentId}/`);
  });

  it('匿名用户的存储前缀走 anon/ 且不含 user_id', () => {
    const contentId = uuidv7(Date.UTC(2026, 7, 19));
    const text = formatRow({ ...base, contentId, userType: 'ANONYMOUS' });

    expect(text).toContain(`存储前缀   anon/202608/${contentId}/`);
    // 归属那一行仍然有 user_id（客服排查要用），但前缀里没有
    expect(text.split('\n').find((line) => line.includes('存储前缀'))).not.toContain('u-1');
  });

  it('存量 v4 内容用 created_at 推前缀（R-53），不崩', () => {
    const text = formatRow({ ...base, contentId: randomUUID(), userType: 'ANONYMOUS' });
    expect(text).toContain('anon/202608/');
    expect(text).not.toContain('NaN');
  });

  it('非 ACTIVE 的归属状态被标出（MERGED 是排查的关键线索）', () => {
    /*
     * 「这个内容的归属用户状态是 MERGED」意味着它是归并来的 ——
     * 而客服看到的下一个问题往常是「为什么产物键在 anon/ 下」。
     */
    const text = formatRow({
      ...base,
      contentId: uuidv7(),
      userType: 'ANONYMOUS',
      userStatus: 'MERGED',
    });
    expect(text).toContain('（ANONYMOUS/MERGED）');
  });

  it('无关联 job/export 时显示 -（而不是空白）', () => {
    const text = formatRow({
      ...base,
      contentId: uuidv7(),
      userType: 'REGISTERED',
      jobIds: [],
      exportIds: [],
    });
    expect(text).toContain('任务       -');
    expect(text).toContain('导出       -');
  });
});
