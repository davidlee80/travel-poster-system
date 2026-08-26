import type { PlannerStepId } from '@tps/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PlannerConfigOption, PlannerConfigResponse } from '@/lib/api-client';
import { OPTION_LISTS } from '@/lib/planner/config-binding';
import { INITIAL_PLANNER_STATE, type PlannerState } from '@/lib/planner/state';
import { buildSnapshot } from '@/lib/planner/step-state';

import { PlannerConfigProvider } from './PlannerConfigProvider';
import { StepPage } from './StepPage';

/**
 * 「随时可以通过配置增删」这件事的端到端断言。
 *
 * ## 为什么必须有这一组
 *
 * `config-binding.test.ts` 证明的是「键对得上」，而键对得上与「改了真的生效」
 * 是两件事：控件层只要有一处仍然直接查内置文案表，键就照样对得上，
 * 而运营改的文案只在一部分控件里出现 —— 症状是同一个标签在第 5 步显示新文案、
 * 在右栏摘要显示旧文案。这一组盯的是渲染产物本身。
 *
 * ## 注入配置而不是起服务
 *
 * `PlannerConfigProvider` 收一个可选的 `value`，测试从这里注入。真实路径是
 * 浏览器里 `GET /api/v1/planner/config`，而那条路径由 `apps/api` 的路由测试
 * 覆盖 —— 在这里再起一个 fetch mock 只会多测一遍 fetch。
 */

/** 从派生表取内置列表，避免在测试里手抄一份选项（抄的那份会与代码漂移）*/
function builtIn(fieldKey: string): readonly string[] {
  const list = OPTION_LISTS.find((entry) => entry.fieldKey === fieldKey);
  if (list === undefined) throw new Error(`派生表里没有 ${fieldKey}`);
  return list.values;
}

function option(key: string, label: string): PlannerConfigOption {
  return { key, label, metadata: {} };
}

function config(fields: Record<string, readonly PlannerConfigOption[]>): PlannerConfigResponse {
  return { version: 3, published_at: '2026-08-25T00:00:00.000Z', fields };
}

/** 原样把某个列表搬进配置，供「只改一处」的场景当基线 */
function asPublished(fieldKey: string, rename: Record<string, string> = {}) {
  return builtIn(fieldKey).map((value) => option(value, rename[value] ?? `内置-${value}`));
}

function render(
  step: PlannerStepId,
  published: PlannerConfigResponse | undefined,
  state: PlannerState = RICH,
): string {
  return renderToStaticMarkup(
    <PlannerConfigProvider {...(published === undefined ? {} : { value: published })}>
      <StepPage
        step={step}
        active
        state={state}
        snapshot={buildSnapshot(state)}
        dispatch={() => undefined}
        onPrev={null}
        onNext={null}
        nextLabel={null}
        registerField={() => undefined}
      />
    </PlannerConfigProvider>,
  );
}

/** 够触发第 5 / 7 步条件分支的一份答案。与 sections.test.tsx 的 RICH 同源 */
const RICH: PlannerState = {
  ...INITIAL_PLANNER_STATE,
  answers: {
    trip: {
      origin: { text: '上海', country: '中国' },
      destination_status: 'CONFIRMED',
      destinations: [{ text: '东京', country: '日本' }],
    },
    transport: { intercity_modes: [{ code: 'transport.flight', stance: 'PREFER' }] },
    interests: { tags: ['interest.nightlife', 'interest.food'] },
  },
};

describe('停用一个选项，界面上就没有了', () => {
  it('目的地状态不展示「完全没定」，即使远端配置仍保留旧选项', () => {
    const after = render(
      '01',
      config({
        'trip.destination_status': [
          option('CONFIRMED', '已经确定'),
          option('SHORTLISTED', '有几个备选'),
          option('UNDECIDED', '完全没定'),
        ],
      }),
    );
    expect(after).toContain('>已经确定</button>');
    expect(after).toContain('>有几个备选</button>');
    expect(after).not.toContain('完全没定');
    expect(after).not.toContain('UNDECIDED');
  });

  it('条件码：停用「夜间活动」之后兴趣多选里不再出现它', () => {
    const before = render('07', undefined);
    expect(before).toContain('夜间活动');

    const kept = builtIn('interests.tags').filter((code) => code !== 'interest.nightlife');
    const after = render(
      '07',
      config({ 'interests.tags': kept.map((code) => option(code, `标签-${code}`)) }),
    );
    expect(after).not.toContain('夜间活动');
    expect(after).toContain('标签-interest.food');
  });

  it('枚举：停用「有几个备选」之后单选卡里不再出现它', () => {
    const kept = builtIn('trip.destination_status').filter((value) => value !== 'SHORTLISTED');
    const after = render(
      '01',
      config({
        'trip.destination_status': kept.map((value) => option(value, `选项-${value}`)),
      }),
    );
    expect(after).toContain('选项-CONFIRMED');
    expect(after).not.toContain('选项-SHORTLISTED');
    /* 内置文案也不该漏出来 —— 漏出来说明有一条路径绕过了解析器 */
    expect(after).not.toContain('有几个备选');
  });
});

describe('改文案与改排序都是纯配置', () => {
  it('文案按配置显示，内置文案不再出现', () => {
    const after = render(
      '01',
      config({
        'trip.destination_status': asPublished('trip.destination_status', {
          CONFIRMED: '已经定死了',
        }),
      }),
    );
    expect(after).toContain('>已经定死了</button>');
    /*
     * 收窄到按钮文本：「已经确定」也出现在这个字段的问句里
     * （「目的地是否已经确定？」），而问句来自 `PLANNER_FIELDS`，
     * 不是选项文案 —— 拿整份标记做 `not.toContain` 会把问句一起算进去。
     */
    expect(after).not.toContain('>已经确定</button>');
  });

  it('排序按配置的顺序渲染', () => {
    const values = [...builtIn('trip.date_flexibility')].reverse();
    const after = render(
      '01',
      config({ 'trip.date_flexibility': values.map((v) => option(v, `弹性-${v}`)) }),
    );
    const positions = values.map((v) => after.indexOf(`弹性-${v}`));
    /* 逐个递增即「渲染顺序与配置顺序一致」。有 -1 说明某一项根本没渲染 */
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('对象数组行内的选项也走配置（订单卡的「类型」）', () => {
    /*
     * 行内部件的路径比字段深一层。漏接这一层的表现最难发现：
     * 字段级选项都跟着配置变了，只有 Repeater 里那几个下拉还是内置文案。
     */
    const state: PlannerState = {
      ...RICH,
      answers: {
        ...RICH.answers,
        trip: {
          ...RICH.answers.trip,
          locked_order_types: ['LODGING'],
          locked_orders: [
            {
              type: 'LODGING',
              name: '',
              datetime_text: '',
              place_text: '',
              changeability: 'UNKNOWN',
            },
          ],
        },
      },
    };
    const after = render(
      '01',
      config({
        'trip.locked_orders.type': asPublished('trip.locked_orders.type', {
          LODGING: '住宿预订',
        }),
      }),
      state,
    );
    expect(after).toContain('住宿预订');
  });
});

describe('新增的能力边界', () => {
  it('条件码列表可以出现内置字典之外的码', () => {
    /*
     * 契约里 `code` 是域前缀正则，因此配置发布一个新码之后前端能渲染、
     * 提交也能过 schema。它仍需进 `conditions.ts` 才能进 Prompt ——
     * 那一步由 `planner-config-coverage.test.ts` 的双向断言盯着。
     */
    const after = render(
      '05',
      config({
        'transport.intercity_modes': [
          ...builtIn('transport.intercity_modes').map((c) => option(c, `旧-${c}`)),
          option('transport.sleeper_bus', '卧铺大巴'),
        ],
      }),
    );
    expect(after).toContain('卧铺大巴');
  });

  it('枚举列表里配置多出来的值被丢弃', () => {
    /*
     * 渲染它只会得到一个「点了提交被 Zod 拒」的按钮，而错误指向
     * `planner_profile.trip.destination_status` —— 运营看不懂。
     * 因此解析器取「配置 ∩ 内置」，并在控制台留一条说明。
     */
    const after = render(
      '01',
      config({
        'trip.destination_status': [
          ...asPublished('trip.destination_status'),
          option('MAYBE', '大概吧'),
        ],
      }),
    );
    expect(after).not.toContain('大概吧');
    expect(after).toContain('内置-CONFIRMED');
  });
});

describe('下线的码还留在草稿里时给得出出路', () => {
  it('提示条数正确，并给一个移除按钮', () => {
    /*
     * 这是「删除」能力的最后一环：配置停用一个码之后界面上标签消失，
     * 但用户几天前的草稿里那个码还在，直接提交会被 N-08 拒 ——
     * 而用户看不到任何线索。不自动清是因为静默丢弃硬约束的后果更糟
     * （见 field-io.ts 的 `staleCodes`）。
     */
    const kept = builtIn('interests.tags').filter((code) => code !== 'interest.nightlife');
    const after = render(
      '07',
      config({ 'interests.tags': kept.map((code) => option(code, `标签-${code}`)) }),
    );
    expect(after).toContain('有 1 项你选过的偏好已经下线');
    expect(after).toContain('移除这 1 项');
  });

  it('没有下线码时不出现提示', () => {
    const after = render('07', config({ 'interests.tags': asPublished('interests.tags') }));
    expect(after).not.toContain('已经下线');
  });

  it('枚举列表停用一个值不产生提示 —— 那不影响提交', () => {
    /* 契约照旧接受那个枚举值，让用户为一件没有后果的事按一次按钮是噪声 */
    const state: PlannerState = {
      ...RICH,
      answers: { ...RICH.answers, risk: { exclusions: ['RED_EYE_FLIGHT'] } },
    };
    const kept = builtIn('risk.exclusions').filter((value) => value !== 'RED_EYE_FLIGHT');
    const after = render(
      '04',
      config({ 'risk.exclusions': kept.map((v) => option(v, `排除-${v}`)) }),
      state,
    );
    expect(after).not.toContain('已经下线');
  });
});

describe('没有配置时逐字节等价于内置', () => {
  it('未注册的 field_key 走内置值与内置文案', () => {
    /*
     * 配置服务不可用、或者迁移漏注册了某个列表，页面都必须照常可填。
     * 这一条同时是「首帧」的行为：配置在浏览器里拉，服务端渲染的那一帧
     * 一定没有配置。
     */
    const empty = render('01', config({}));
    expect(empty).toBe(render('01', undefined));
    expect(empty).toContain('已经确定');
  });
});
