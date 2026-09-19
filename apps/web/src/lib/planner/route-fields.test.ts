import { describe, expect, it } from 'vitest';

import { ROUTE_FIELDS, ROUTE_FIELD_IDS, isRouteFieldId } from './route-fields';

/**
 * 占位字段注册表的结构性守护。
 *
 * 这张表是「第 1 步按路线定制」的数据源，它的每一处损坏都表现为
 * 「用户点了没反应」或「提交被拒」—— 因此注册表自身的完整性
 * （ID 前缀、apiKey 归属、requires 指向）由这里守住，而不是靠
 * 页面上肉眼核对。
 */
describe('ROUTE_FIELDS 注册表', () => {
  it('每个键都等于它声明的 fieldId（防复制粘贴漂移）', () => {
    for (const [key, spec] of Object.entries(ROUTE_FIELDS)) {
      expect(spec.fieldId).toBe(key);
    }
  });

  it('fieldId 全部是 RT- 前缀（与契约 76 字段在命名上物理隔离）', () => {
    for (const id of ROUTE_FIELD_IDS) {
      expect(id).toMatch(/^RT-[A-Z]{3}-\d{2}$/);
    }
  });

  it('apiKey 全部落在 route_<route> 隔离块（提交时整块剔除）', () => {
    for (const spec of Object.values(ROUTE_FIELDS)) {
      expect(spec.apiKey).toMatch(/^route_(explore|destination|time)\.[a-z_]+$/);
    }
  });

  it('每条路线的 apiKey 块与它的字段 ID 前缀一致（EXP→explore 等）', () => {
    const prefixToBlock: Record<string, string> = {
      EXP: 'explore',
      DST: 'destination',
      TIM: 'time',
    };
    for (const spec of Object.values(ROUTE_FIELDS)) {
      const prefix = spec.fieldId.split('-')[1] ?? '';
      const block = prefixToBlock[prefix];
      expect(block, `${spec.fieldId} 的路线前缀`).toBeDefined();
      expect(spec.apiKey.startsWith(`route_${block}.`)).toBe(true);
    }
  });

  it('同一 apiKey 块内没有重复的叶子键（route_time.window 只注册一次）', () => {
    const seen = new Set<string>();
    for (const spec of Object.values(ROUTE_FIELDS)) {
      expect(seen.has(spec.apiKey), `${spec.apiKey} 重复注册`).toBe(false);
      seen.add(spec.apiKey);
    }
  });

  it('多部件字段的 requires 指向本字段内的兄弟键', () => {
    for (const spec of Object.values(ROUTE_FIELDS)) {
      const keys = new Set(
        spec.descriptor.parts.map((part) => part.key).filter((key) => key !== null),
      );
      for (const part of spec.descriptor.parts) {
        if (part.requires === undefined) continue;
        expect(
          keys.has(part.requires.key),
          `${spec.fieldId} 的 requires.key="${part.requires.key}" 不在本字段部件里`,
        ).toBe(true);
      }
    }
  });

  it('带 options 的部件，其选项值在 labels 里都有文案（界面不许出现裸值按钮）', () => {
    for (const spec of Object.values(ROUTE_FIELDS)) {
      for (const part of spec.descriptor.parts) {
        for (const value of part.options ?? []) {
          expect(
            spec.labels[value],
            `${spec.fieldId} 的选项 "${value}" 缺文案`,
          ).toBeDefined();
        }
      }
    }
  });

  it('isRouteFieldId 守卫：注册过的返回 true，契约字段与拼错的返回 false', () => {
    expect(isRouteFieldId('RT-EXP-01')).toBe(true);
    expect(isRouteFieldId('RT-TIM-04')).toBe(true);
    expect(isRouteFieldId('PV2-01-001')).toBe(false);
    expect(isRouteFieldId('RT-EXP-99')).toBe(false);
    expect(isRouteFieldId('')).toBe(false);
  });

  it('ROUTE_FIELD_IDS 与注册表键一致', () => {
    expect([...ROUTE_FIELD_IDS].sort()).toEqual(Object.keys(ROUTE_FIELDS).sort());
  });
});
