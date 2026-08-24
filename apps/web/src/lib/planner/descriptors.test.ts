import { CONDITION_LABEL } from '@tps/presentation';
import {
  CONDITION_CODES_BY_DOMAIN,
  PLANNER_FIELDS,
  PLANNER_FIELD_COUNT,
  plannerField,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  CONTROL_PRIMITIVES,
  FIELD_DESCRIPTORS,
  PROJECTION_ONLY_CODES,
  TRISTATE_CODES,
  declaredOptionValues,
  type FieldPart,
} from './descriptors';
import { OPTION_LABEL } from './field-spec';

/** 深度遍历一个字段的全部部件（含 `object-list` 的行部件）*/
function allParts(fieldId: (typeof PLANNER_FIELDS)[number]['field_id']): readonly FieldPart[] {
  const descriptor = FIELD_DESCRIPTORS[fieldId];
  if (descriptor.kind !== 'parts') return [];
  const out: FieldPart[] = [];
  const walk = (parts: readonly FieldPart[]): void => {
    for (const part of parts) {
      out.push(part);
      if (part.item_parts !== undefined) walk(part.item_parts);
    }
  };
  walk(descriptor.parts);
  return out;
}

describe('描述符表覆盖 76 个字段', () => {
  it('每个 field_id 都有描述符', () => {
    /*
     * `Record<PlannerFieldId, …>` 已经在编译期保证了这件事。这条运行期断言
     * 防的是另一种情况：有人把它改成 `Partial<Record<…>>` 以「先跳过一个
     * 难做的字段」—— 那时编译通过，而界面上那个字段变成一个空白区块。
     */
    expect(Object.keys(FIELD_DESCRIPTORS)).toHaveLength(PLANNER_FIELD_COUNT);
    const missing = PLANNER_FIELDS.filter(
      (spec) => FIELD_DESCRIPTORS[spec.field_id] === undefined,
    ).map((spec) => spec.field_id);
    expect(missing).toEqual([]);
  });

  it('没有指向不存在字段的描述符', () => {
    const known = new Set<string>(PLANNER_FIELDS.map((spec) => spec.field_id));
    expect(Object.keys(FIELD_DESCRIPTORS).filter((id) => !known.has(id))).toEqual([]);
  });

  it('每个字段至少有一个部件 —— 空 parts 是一个不会报错的空区块', () => {
    const empty = PLANNER_FIELDS.filter((spec) => {
      const descriptor = FIELD_DESCRIPTORS[spec.field_id];
      return descriptor.kind === 'parts' && descriptor.parts.length === 0;
    }).map((spec) => spec.field_id);
    expect(empty).toEqual([]);
  });

  it('三个非 parts 描述符恰好是复核面板、阻塞项列表与文件导入', () => {
    /*
     * 锁定这三个的身份。将来若有人把某个普通字段临时改成
     * `{ kind: 'upload-entry' }` 来「先放个占位」，这条会红 ——
     * 而占位符在界面上与「已经做完了」看起来完全一样。
     */
    const special = PLANNER_FIELDS.filter(
      (spec) => FIELD_DESCRIPTORS[spec.field_id].kind !== 'parts',
    ).map((spec) => [spec.field_id, FIELD_DESCRIPTORS[spec.field_id].kind]);
    expect(special).toEqual([
      ['PV2-09-001', 'review-board'],
      ['PV2-09-002', 'blocker-list'],
      ['PV2-10-005', 'upload-entry'],
    ]);
  });
});

describe('部件声明自洽', () => {
  it('原语都在清单里', () => {
    const known = new Set<string>(CONTROL_PRIMITIVES);
    const unknown = PLANNER_FIELDS.flatMap((spec) =>
      allParts(spec.field_id)
        .filter((part) => !known.has(part.primitive))
        .map((part) => `${spec.field_id} ${part.primitive}`),
    );
    expect(unknown).toEqual([]);
  });

  it('多部件字段的每个部件都有键与标签', () => {
    /*
     * 单部件字段可以 `key: null` 且不带标签（区块标题就是那个问句）。
     * 多部件字段里 `key: null` 会让两个部件写到同一个位置，
     * 而缺标签会让屏读用户听到两个没有名字的控件（违反规范 20 的「显式 label」）。
     */
    const problems: string[] = [];
    for (const spec of PLANNER_FIELDS) {
      const descriptor = FIELD_DESCRIPTORS[spec.field_id];
      if (descriptor.kind !== 'parts' || descriptor.parts.length < 2) continue;
      for (const part of descriptor.parts) {
        if (part.key === null) problems.push(`${spec.field_id} 有多个部件但其中一个 key 为 null`);
        if (part.label === undefined) problems.push(`${spec.field_id}.${part.key ?? ''} 缺标签`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('object-list 都给了行默认值 —— 缺了会写出缺必填键的行', () => {
    const problems = PLANNER_FIELDS.flatMap((spec) =>
      allParts(spec.field_id)
        .filter(
          (part) =>
            part.primitive === 'object-list' &&
            (part.item_parts === undefined || part.item_defaults === undefined),
        )
        .map((part) => `${spec.field_id}.${part.key ?? 'self'}`),
    );
    expect(problems).toEqual([]);
  });

  it('object-list 的行默认值只用行部件声明过的键', () => {
    /*
     * 默认值里写一个 `item_parts` 没有的键 = 一个用户永远看不到、
     * 也改不掉的值被发进契约。房型配置的 `room_index` 是唯一例外 ——
     * 它由 `index_key` 自动写入，因此不需要（也不该有）行部件。
     */
    const problems: string[] = [];
    for (const spec of PLANNER_FIELDS) {
      for (const part of allParts(spec.field_id)) {
        if (part.primitive !== 'object-list' || part.item_defaults === undefined) continue;
        const declared = new Set((part.item_parts ?? []).map((entry) => entry.key));
        for (const key of Object.keys(part.item_defaults)) {
          if (key === part.index_key) continue;
          if (!declared.has(key)) problems.push(`${spec.field_id}.${part.key ?? 'self'}.${key}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('requires 指向的兄弟键真的存在', () => {
    const problems: string[] = [];
    const check = (owner: string, parts: readonly FieldPart[]): void => {
      const keys = new Set(parts.map((part) => part.key));
      for (const part of parts) {
        if (part.requires !== undefined && !keys.has(part.requires.key)) {
          problems.push(`${owner}.${part.key ?? 'self'} → ${part.requires.key}`);
        }
        if (part.item_parts !== undefined) check(owner, part.item_parts);
      }
    };
    for (const spec of PLANNER_FIELDS) {
      const descriptor = FIELD_DESCRIPTORS[spec.field_id];
      if (descriptor.kind === 'parts') check(spec.field_id, descriptor.parts);
    }
    expect(problems).toEqual([]);
  });

  it('follow_count 与 truncates 成对出现', () => {
    /*
     * 「行数跟着计数器」与「计数器变小时截断数组」是同一条规则的两半
     * （规范 8 与 12）。只做前一半的表现是数组比计数器长，而 PV2-02-002 的
     * 校验会报「比同行人数多了 2 位」—— 用户明明只是把人数改小了。
     */
    const followed = new Set(
      PLANNER_FIELDS.flatMap((spec) =>
        allParts(spec.field_id).flatMap((part) =>
          part.follow_count === undefined ? [] : [`${part.follow_count}→${spec.api_key}`],
        ),
      ),
    );
    const truncating = new Set(
      PLANNER_FIELDS.flatMap((spec) =>
        allParts(spec.field_id).flatMap((part) =>
          part.truncates === undefined ? [] : [`${spec.api_key}→${part.truncates}`],
        ),
      ),
    );
    expect([...followed].sort()).toEqual([...truncating].sort());
  });

  it('options_from 指向一个真实的 api_key', () => {
    const known = new Set<string>(PLANNER_FIELDS.map((spec) => spec.api_key));
    const problems = PLANNER_FIELDS.flatMap((spec) =>
      allParts(spec.field_id)
        .filter((part) => part.options_from !== undefined && !known.has(part.options_from))
        .map((part) => `${spec.field_id} → ${part.options_from ?? ''}`),
    );
    expect(problems).toEqual([]);
  });
});

describe('选项值都有中文文案', () => {
  it('描述符声明的每个选项值都能查到文案', () => {
    /*
     * 与 `field-spec.test.ts` 那条断言方向相反、缺一不可：
     * 那一条问「契约枚举里的值有没有文案」，这一条问
     * 「界面上会出现的值有没有文案」。两者的差集正是
     * `PROJECTION_ONLY_CODES`（在契约里但界面上不出现）与
     * 拼错的选项来源（界面上出现但契约里没有）。
     */
    /*
     * 查两张表而不是「`optionLabel` 的返回值等于原值就算漏配」：
     * `SUV` 的正确中文文案就是「SUV」，而按返回值判定会把它报成漏配 ——
     * 而修那条假警报最省事的做法是把它加进白名单，
     * 于是白名单迟早会盖住一条真的漏配。
     */
    const conditionLabels: Record<string, string | undefined> = CONDITION_LABEL;
    const missing: string[] = [];
    for (const spec of PLANNER_FIELDS) {
      for (const value of declaredOptionValues(spec.field_id)) {
        const own = OPTION_LABEL[spec.api_key]?.[value];
        if (own === undefined && conditionLabels[value] === undefined) {
          missing.push(`${spec.field_id} ${spec.api_key} ${value}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('文案表里的每个 api_key 都真的有选项型部件', () => {
    /*
     * 反向：给一个没有选项的字段配了一表文案 = 死文案。
     * 它不会报错，只会在下一次有人照着这张表推断「这个字段是选择题」时误导他。
     */
    /* `Set<string>` 而不是让它推成 api_key 的字面量联合 —— 这里比较的是运行期字符串 */
    const withOptions = new Set<string>(
      PLANNER_FIELDS.filter((spec) => declaredOptionValues(spec.field_id).length > 0).map(
        (spec) => spec.api_key,
      ),
    );
    expect(Object.keys(OPTION_LABEL).filter((apiKey) => !withOptions.has(apiKey))).toEqual([]);
  });
});

describe('三态标签的条件码分组穷尽两个域', () => {
  it('交通域的码 = 跨城 ∪ 当地 ∪ 只作投影的码', () => {
    /*
     * 这条断言的价值：P9 往 `conditions.ts` 里加了 5 个 transport 码，
     * 而只加码不加进这两张分组表的表现是「界面上少一个选项」——
     * 没有任何报错，且很容易被当成「设计稿里没有这一项」。
     */
    const grouped = new Set<string>([
      ...TRISTATE_CODES['transport.intercity_modes'],
      ...TRISTATE_CODES['transport.local_modes'],
      ...PROJECTION_ONLY_CODES,
    ]);
    const missing = CONDITION_CODES_BY_DOMAIN.transport.filter((code) => !grouped.has(code));
    expect(missing).toEqual([]);
  });

  it('住宿域的码 = 类型 ∪ 设施 ∪ 只作投影的码', () => {
    const grouped = new Set<string>([
      ...TRISTATE_CODES['lodging.types'],
      ...TRISTATE_CODES['lodging.amenities'],
      ...PROJECTION_ONLY_CODES,
    ]);
    const missing = CONDITION_CODES_BY_DOMAIN.accommodation.filter((code) => !grouped.has(code));
    expect(missing).toEqual([]);
  });

  it('分组表里没有不存在的码', () => {
    const known = new Set<string>([
      ...CONDITION_CODES_BY_DOMAIN.transport,
      ...CONDITION_CODES_BY_DOMAIN.accommodation,
      ...CONDITION_CODES_BY_DOMAIN.budget,
      ...CONDITION_CODES_BY_DOMAIN.interest,
    ]);
    const unknown = Object.values(TRISTATE_CODES)
      .flat()
      .filter((code) => !known.has(code));
    expect(unknown).toEqual([]);
  });

  it('自驾同时出现在跨城与当地两组 —— 这是刻意的', () => {
    /*
     * 「自驾去另一个城市」与「到了当地租车」是两个不同的决定：前者影响
     * 跨城路线，后者影响每日行程。同一个码出现在两个字段里因此是对的，
     * 而这条断言防的是有人在「去重」时把其中一处删掉。
     */
    expect(TRISTATE_CODES['transport.intercity_modes']).toContain('transport.self_drive');
    expect(TRISTATE_CODES['transport.local_modes']).toContain('transport.self_drive');
  });
});

describe('三态标签只用在主观取舍上（规范 4.2）', () => {
  it('饮食、宗教与过敏字段都不是三态', () => {
    /*
     * 规范 4.2 明令禁止用三态循环表达宗教与饮食要求，规范 13 对过敏同样。
     * 「偏好清真」不是一个有意义的表达，而「偏好不吃花生」在安全上是危险的。
     */
    for (const fieldId of ['PV2-07-002', 'PV2-07-003', 'PV2-07-004'] as const) {
      const primitives = allParts(fieldId).map((part) => part.primitive);
      expect(primitives).not.toContain('tristate');
    }
  });

  it('用三态的四个字段都是规范列出的那四组', () => {
    const tristate = PLANNER_FIELDS.filter((spec) =>
      allParts(spec.field_id).some((part) => part.primitive === 'tristate'),
    ).map((spec) => spec.api_key);
    expect(tristate.sort()).toEqual([
      'budget.scope_and_priorities',
      'lodging.amenities',
      'lodging.types',
      'transport.intercity_modes',
      'transport.local_modes',
    ]);
  });
});

describe('第 10 步的字段不参与主问卷', () => {
  it('它们的层级都是 POST_PLAN', () => {
    /* 触发引擎靠这一列把它们从九步里排除（`isTriggered` 的第一行）*/
    const wrong = PLANNER_FIELDS.filter(
      (spec) => spec.step === '10' && plannerField(spec.field_id).level !== 'POST_PLAN',
    ).map((spec) => spec.field_id);
    expect(wrong).toEqual([]);
  });
});
