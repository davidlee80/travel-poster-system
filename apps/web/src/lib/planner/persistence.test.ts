import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_ID_VALUES } from '@tps/schemas';

import { loadDraft, saveDraft } from './persistence';
import { INITIAL_PLANNER_STATE } from './state';

const STORAGE_KEY = 'tps.planner.v2.draft';

describe('Planner 草稿版本迁移', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('v1 的 UNDECIDED 被清掉，但目的地和其他答案仍保留', () => {
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: '2026-08-26T00:00:00.000Z',
        answers: {
          trip: {
            destination_status: 'UNDECIDED',
            destinations: [{ text: '东京', country: '日本' }],
          },
          travelers: { count: 2 },
        },
        touched: ['PV2-01-002', 'PV2-01-003'],
        optIns: [],
        activeStep: '01',
      }),
    );

    const restored = loadDraft();
    expect(restored?.answers.trip?.destination_status).toBeUndefined();
    expect(restored?.answers.trip?.destinations).toEqual([{ text: '东京', country: '日本' }]);
    expect(restored?.answers.travelers?.count).toBe(2);
  });

  it('新保存的草稿使用 v2', () => {
    expect(saveDraft(INITIAL_PLANNER_STATE, '2026-08-26T00:00:00.000Z')).toBe(true);
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? '{}')).toMatchObject({ version: 2 });
  });

  /* 以下三条在同一个 describe 里：`storage` 与 localStorage 桩都在这一层（R-85 P3） */

  it('选中的套件存得下也读得回', () => {
    const picked = TEMPLATE_ID_VALUES[1] ?? TEMPLATE_ID_VALUES[0];
    expect(
      saveDraft({ ...INITIAL_PLANNER_STATE, templateId: picked }, '2026-08-28T00:00:00.000Z'),
    ).toBe(true);

    expect(loadDraft()?.templateId).toBe(picked);
  });

  it('旧草稿缺这个键时落到 null，而不是作废整份', () => {
    /*
     * **这是加这个字段不需要升 `DRAFT_VERSION` 的依据。**
     *
     * 升版的后果是所有人的九步草稿因为多了一个可选字段而被丢弃，
     * 而 `loadDraft` 以 `...INITIAL_PLANNER_STATE` 打底再逐字段覆盖，
     * 因此缺键本来就能安全落到 `null`。
     */
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        savedAt: '2026-08-27T00:00:00.000Z',
        answers: { travelers: { count: 2 } },
        touched: [],
        optIns: [],
        activeStep: '03',
        /* templateId 刻意不写 */
      }),
    );

    const restored = loadDraft();
    expect(restored).not.toBeNull();
    expect(restored?.templateId).toBeNull();
    /* 其余字段照常恢复 —— 不是整份作废 */
    expect(restored?.answers.travelers?.count).toBe(2);
    expect(restored?.activeStep).toBe('03');
  });

  it('草稿里已退役的套件 ID 回退到 null', () => {
    /*
     * 草稿在浏览器里能活很久，而套件会重命名（`travel_infographic_v1`
     * → `ink_paper_v1` 就发生过）或下架。不校验的后果是一个已退役的 ID
     * 一路送到请求里被 `z.enum` 拒成 REQ_SCHEMA_INVALID —— 而用户只是
     * 接着填上周的草稿，屏幕上没有任何地方提示他选过一个已不存在的样式。
     */
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        savedAt: '2026-08-27T00:00:00.000Z',
        answers: {},
        touched: [],
        optIns: [],
        activeStep: '01',
        templateId: 'travel_infographic_v1',
      }),
    );

    expect(loadDraft()?.templateId).toBeNull();
  });
});
