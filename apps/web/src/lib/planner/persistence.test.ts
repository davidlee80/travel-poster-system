import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
