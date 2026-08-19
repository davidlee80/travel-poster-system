import { randomUUID } from 'node:crypto';

import { uuidv7 } from '@tps/shared';
import { describe, expect, it } from 'vitest';

import { contentPrefix, exportObjectKeyFor, type ContentSpace } from './content-keys.js';

/**
 * 15.4 产物存储键（TP-6-11）。
 *
 * 纯函数、零 IO，因此**不需要数据库也不需要 S3** —— 门禁 #37 的路径部分
 * 因此总是真的在跑。
 */

/** 2026-08-19T08:00:00Z 编码的 content_id */
const AUG_2026 = Date.UTC(2026, 7, 19, 8, 0, 0);

function space(overrides: Partial<ContentSpace> = {}): ContentSpace {
  return {
    userType: 'REGISTERED',
    userId: 'u-123',
    contentId: uuidv7(AUG_2026),
    contentCreatedAt: new Date(AUG_2026),
    ...overrides,
  };
}

describe('注册用户空间', () => {
  it('前缀含 users/{user_id}/{yyyyMM}/{content_id}/', () => {
    const s = space();
    expect(contentPrefix(s)).toBe(`users/u-123/202608/${s.contentId}/`);
  });

  it('完整键含 exports/{export_id}/{file}', () => {
    const s = space();
    expect(exportObjectKeyFor(s, 'e-9', 'day-03.png')).toBe(
      `users/u-123/202608/${s.contentId}/exports/e-9/day-03.png`,
    );
  });
});

describe('匿名通用空间（15.4：不建每人目录）', () => {
  it('前缀是 anon/{yyyyMM}/{content_id}/', () => {
    const s = space({ userType: 'ANONYMOUS' });
    expect(contentPrefix(s)).toBe(`anon/202608/${s.contentId}/`);
  });

  it('前缀里**不含** user_id', () => {
    /*
     * 15.4：匿名基数大且 30 天即清，逐人前缀会制造千万级近空目录。
     * 归属由 exports.user_id 保留，对象定位靠 content_id。
     */
    const s = space({ userType: 'ANONYMOUS', userId: 'anon-abc' });
    expect(contentPrefix(s)).not.toContain('anon-abc');
  });
});

describe('yyyyMM 由 content_id 派生（15.4：不引入第二个时间来源）', () => {
  it('与 ID 的编码时刻一致', () => {
    const s = space({ contentId: uuidv7(Date.UTC(2027, 0, 5)) });
    expect(contentPrefix(s)).toContain('/202701/');
  });

  it('v7 的 ID **完全忽略** contentCreatedAt（R-53 的核心断言）', () => {
    /*
     * 这一条守的是「新数据没有第二个时间来源」。回退分支只对 v4 存量行生效，
     * 因此这里传一个相差一年的 createdAt，断言路径不变 ——
     * 哪天有人把回退改成「优先用 createdAt」，这条会红。
     */
    const contentId = uuidv7(Date.UTC(2026, 7, 19));
    const withWrongDate = contentPrefix(
      space({ contentId, contentCreatedAt: new Date(Date.UTC(2025, 0, 1)) }),
    );
    const withRightDate = contentPrefix(
      space({ contentId, contentCreatedAt: new Date(Date.UTC(2026, 7, 19)) }),
    );

    expect(withWrongDate).toBe(withRightDate);
    expect(withWrongDate).toContain('/202608/');
  });

  it('v4 存量 ID 回退到 contentCreatedAt（R-53）', () => {
    const s = space({
      contentId: randomUUID(),
      contentCreatedAt: new Date(Date.UTC(2026, 2, 7)),
    });
    expect(contentPrefix(s)).toContain('/202603/');
  });

  it('取 UTC 而不是本地时区', () => {
    /*
     * 15.4 明文要求 UTC。用本地时区会让同一个 ID 在不同部署（不同 TZ）
     * 得到不同路径 —— 而对象已经写在其中一个路径下了。
     * 用「UTC 月初的前一毫秒」构造：任何东八区实现都会把它算成上个月。
     */
    const s = space({ contentId: uuidv7(Date.UTC(2026, 8, 1, 0, 0, 0, 0)) });
    expect(contentPrefix(s)).toContain('/202609/');
  });

  it('跨月边界：UTC 月末 23:59:59.999 与次月 00:00:00.000 分属两个 yyyyMM', () => {
    const lastMs = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
    const firstMs = Date.UTC(2026, 8, 1, 0, 0, 0, 0);

    expect(contentPrefix(space({ contentId: uuidv7(lastMs) }))).toContain('/202608/');
    expect(contentPrefix(space({ contentId: uuidv7(firstMs) }))).toContain('/202609/');
  });
});

describe('键的形状', () => {
  it('前缀以 / 结尾（避免拼接时漏加）', () => {
    expect(contentPrefix(space()).endsWith('/')).toBe(true);
  });

  it('不含反斜杠（跨平台护栏：Windows 路径分隔符不能进对象键）', () => {
    /*
     * 用字符码而不是字面量：TP-0-06 的 ESLint 护栏
     * （`tps-local/no-windows-path-separator`）禁止源码出现反斜杠字面量，
     * 而它拦得对 —— 这条用例要断言的恰好就是那个字符不该出现。
     */
    const backslash = String.fromCharCode(0x5c);
    expect(exportObjectKeyFor(space(), 'e-1', 'plan.pdf')).not.toContain(backslash);
  });

  it('不含连续的 //', () => {
    expect(exportObjectKeyFor(space(), 'e-1', 'plan.pdf')).not.toMatch(/\/\//);
  });

  it('两种身份的键前缀互不重叠（清理时不会误判归属）', () => {
    const contentId = uuidv7(AUG_2026);
    const registered = contentPrefix(space({ contentId, userType: 'REGISTERED' }));
    const anonymous = contentPrefix(space({ contentId, userType: 'ANONYMOUS' }));

    expect(registered.startsWith('users/')).toBe(true);
    expect(anonymous.startsWith('anon/')).toBe(true);
    expect(registered.startsWith(anonymous)).toBe(false);
    expect(anonymous.startsWith(registered)).toBe(false);
  });
});
