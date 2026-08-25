import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONDITION_CODE_COUNT, CONDITION_CODE_VALUES, isKnownConditionCode } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { OPTION_LISTS, PROJECTED_CODES_FIELD_KEY } from './config-binding';
import { FIELD_DESCRIPTORS } from './descriptors';

/**
 * 「界面上每一个可点的选项都能被配置改掉」这件事的守卫。
 *
 * ## 两组断言各防什么
 *
 * 1. **派生表自身**：键唯一、长度进得了 `VARCHAR(80)`、`kind` 判定没有混淆
 *    条件码与枚举。混淆的后果是把枚举列表当成开放的 —— 于是配置里一个拼错的
 *    枚举值会被渲染成按钮，点了提交被 Zod 拒。
 * 2. **迁移 ⇄ 代码**：描述符里加一个带选项的部件而忘了注册进迁移，那个列表
 *    就静默退回硬编码。运营改了配置没生效，而界面看起来完全正常 ——
 *    没有这组断言，这件事只能靠运营来报。
 *
 * 两组都只证明「键对得上」，而键对得上与「改了真的生效」是两件事：控件层只要
 * 有一处仍然直接查内置文案表，键就照样对得上。后者由
 * `components/planner/config-driven.test.tsx` 在渲染产物里逐个验证。
 *
 * ## 为什么迁移断言不算「限制了运行期的可配性」
 *
 * 它比的是**仓库里的迁移**与**仓库里的代码**，与生产库的当前内容无关 ——
 * 运营在生产库里增删改是运行期行为，不碰迁移文件。这与
 * `apps/api/src/routes/planner-config-coverage.test.ts` 的取舍一致。
 */

const MIGRATION = path.join(
  fileURLToPath(import.meta.url),
  /* .../apps/web/src/lib/planner/config-binding.test.ts → 仓库根 */
  '../../../../../..',
  'infrastructure/migrations/0012_planner_config_all_options.sql',
);

// ── 迁移文本的解析 ──────────────────────────────────────────

interface RegisteredRow {
  readonly fieldKey: string;
  readonly optionKey: string;
  readonly label: string;
  readonly kind: string;
}

/**
 * 0012 注册的全部行。
 *
 * 按 `INSERT INTO` 切块取 `value_kind`（一条语句里的元组同属一类），
 * 块内扫元组的前三列。与 apps/api 那份扫描器同源 —— 两处都读同一份 SQL，
 * 但断言的东西不同：那边是「码 ⇄ 内置字典」，这边是「列表 ⇄ 描述符」。
 */
function registeredRows(): readonly RegisteredRow[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const out: RegisteredRow[] = [];
  for (const block of sql.split('INSERT INTO planner_config_options').slice(1)) {
    const kind = /"value_kind"\s*:\s*"([A-Z_]+)"/.exec(block)?.[1] ?? '';
    for (const match of block.matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'((?:[^']|'')*)'/g)) {
      const [, fieldKey, optionKey, label] = match;
      if (fieldKey === undefined || optionKey === undefined || label === undefined) continue;
      out.push({ fieldKey, optionKey, label: label.replace(/''/g, "'"), kind });
    }
  }
  return out;
}

const ROWS = registeredRows();

// ── 1. 派生表自身 ───────────────────────────────────────────

describe('选项列表的派生', () => {
  it('扫描确实抓到了行 —— 否则下面的双向断言会一半空转', () => {
    /*
     * 正则失效时 `ROWS` 变成空数组，于是「注册的都在代码里」会通过
     * （空集是任何集合的子集），只有「代码里的都注册了」报红。
     * 这一条让扫描失效表现为明确的红。
     */
    expect(ROWS.length).toBeGreaterThan(300);
  });

  it('field_key 唯一，且进得了 VARCHAR(80)', () => {
    const keys = OPTION_LISTS.map((list) => list.fieldKey);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(80);
  });

  it('field_key 就是 api_key 或它下面的一条路径', () => {
    /*
     * 这条守的是「配置的键与载荷路径同一口径」。一旦有一个键不在字段的
     * api_key 之下，`useSummaryLabel` 的前缀匹配就找不到它 ——
     * 症状是主栏显示配置文案、右栏摘要显示内置文案。
     */
    for (const list of OPTION_LISTS) {
      expect(
        list.fieldKey === list.apiKey || list.fieldKey.startsWith(`${list.apiKey}.`),
        `${list.fieldId} ${list.fieldKey} 不在 ${list.apiKey} 之下`,
      ).toBe(true);
    }
  });

  it('CONDITION_CODE 与 ENUM 泾渭分明', () => {
    for (const list of OPTION_LISTS) {
      const codes = list.values.filter((value) => isKnownConditionCode(value));
      if (list.kind === 'CONDITION_CODE') {
        expect(codes.length, `${list.fieldKey} 混了非条件码`).toBe(list.values.length);
      } else {
        /*
         * 一个 ENUM 列表里混进条件码意味着 `kindOf` 的「全部是码」判定
         * 差一个值就翻面。报出混进来的那些 —— 那份清单就是要修的内容。
         */
        expect(codes, `${list.fieldKey} 混了条件码`).toEqual([]);
      }
    }
  });

  it('恰好 6 个条件码列表，与三态标签加兴趣多选对得上', () => {
    expect(OPTION_LISTS.filter((list) => list.kind === 'CONDITION_CODE').map((l) => l.fieldKey))
      .toEqual([
        'budget.scope_and_priorities.priorities',
        'transport.intercity_modes',
        'transport.local_modes',
        'lodging.types',
        'lodging.amenities',
        'interests.tags',
      ]);
  });

  it('`options_from` 的部件不入表 —— 它的可配性归源列表', () => {
    /* `interests.top3` 的选项是用户勾了哪些兴趣，配置改 `interests.tags` 即可 */
    expect(OPTION_LISTS.some((list) => list.fieldId === 'PV2-07-007')).toBe(false);
    expect(FIELD_DESCRIPTORS['PV2-07-007']).toMatchObject({
      parts: [{ options_from: 'interests.tags' }],
    });
  });
});

// ── 2. 迁移 ⇄ 代码 ──────────────────────────────────────────

describe('0012 与描述符表一致', () => {
  it('注册的 field_key 集合 == 62 个派生键 + 投影专用键', () => {
    const expected = [...OPTION_LISTS.map((l) => l.fieldKey), PROJECTED_CODES_FIELD_KEY].sort();
    const actual = [...new Set(ROWS.map((row) => row.fieldKey))].sort();
    expect(actual).toEqual(expected);
  });

  it('每个 field_key 的选项值与内置值逐个相同（含顺序）', () => {
    /*
     * 逐个相同而不是集合相同：`sort_order` 决定界面顺序，而顺序是产品决定 ——
     * 「先问经济舱还是先问头等舱」不该在迁移里被打乱。
     */
    for (const list of OPTION_LISTS) {
      const registered = ROWS.filter((row) => row.fieldKey === list.fieldKey).map(
        (row) => row.optionKey,
      );
      expect(registered, list.fieldKey).toEqual([...list.values]);
    }
  });

  it('每个 field_key 的 value_kind 与派生的 kind 相同', () => {
    for (const list of OPTION_LISTS) {
      const kinds = new Set(
        ROWS.filter((row) => row.fieldKey === list.fieldKey).map((row) => row.kind),
      );
      expect([...kinds], list.fieldKey).toEqual([list.kind]);
    }
  });

  it('0012 自身注册了全部 61 个条件码', () => {
    /*
     * 「自身」是关键：0012 停用了 0010 的 16 个遗留 field_key，
     * 那些行不再进白名单。因此不能靠「跨全部迁移扫一遍」来满足覆盖 ——
     * 那样算出来的集合包含已经停用的行。
     */
    const codes = new Set(ROWS.filter((r) => r.kind === 'CONDITION_CODE').map((r) => r.optionKey));
    expect(CONDITION_CODE_VALUES.filter((code) => !codes.has(code))).toEqual([]);
    expect(codes.size).toBe(CONDITION_CODE_COUNT);
  });

  it('投影专用键下恰好是界面上没有标签的那些码', () => {
    const shown = new Set(
      OPTION_LISTS.filter((l) => l.kind === 'CONDITION_CODE').flatMap((l) => l.values),
    );
    const projected = ROWS.filter((row) => row.fieldKey === PROJECTED_CODES_FIELD_KEY).map(
      (row) => row.optionKey,
    );
    /*
     * 双向：多一个（界面上其实有标签的码也放进来了）会让同一个码在配置里
     * 出现两次，运营改文案时只改到一处；少一个（投影会产出但没注册）会让
     * 提交被 N-08 拒 —— 而那个码的来源是一个枚举答案，用户根本不知道
     * 自己「选过」它。
     */
    expect(projected.filter((code) => shown.has(code))).toEqual([]);
    expect(projected.length + shown.size).toBe(CONDITION_CODE_COUNT);
  });

  it('每一行都有非空文案', () => {
    expect(ROWS.filter((row) => row.label.trim().length === 0)).toEqual([]);
  });

  it('0012 停用了 P8 的 16 个遗留 field_key', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const disabled = /SET enabled = FALSE[\s\S]*?field_key IN \(([\s\S]*?)\);/.exec(sql)?.[1] ?? '';
    const keys = [...disabled.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toHaveLength(16);
    /* 抽两个代表：一个是旧命名的标签字段，一个是 V2 完全没有的概念 */
    expect(keys).toContain('transport.mode_tags');
    expect(keys).toContain('budget.tiers');
    /* 停用的键不能与仍在用的键重名 —— 那会把正在用的列表一起关掉 */
    const live = new Set(OPTION_LISTS.map((list) => list.fieldKey));
    expect(keys.filter((key) => key !== undefined && live.has(key))).toEqual([]);
  });
});
