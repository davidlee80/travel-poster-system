import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { PlannerConfigOption, PlannerConfigResponse } from '@/lib/api-client';
import type { PlannerAction } from '@/lib/planner/state';

import { PlannerConfigProvider } from './PlannerConfigProvider';
import { TemplatePicker } from './TemplatePicker';

/**
 * 输出样式选择器（R-85 P3）。
 *
 * ## 为什么用 renderToStaticMarkup 而不是 jsdom
 *
 * web 侧没有 jsdom 依赖，而这里要验的是「产物里有没有这张图 / 这个标签 /
 * 这个选中态」，不需要 DOM API。与 `config-driven.test.tsx` 同一处理。
 *
 * 代价是**点击验不了** —— 因此 `onClick` 的行为由 `state.ts` 的 reducer
 * 与 `request.test.ts` 的载荷断言两边夹住，而这里只验「渲对了什么」。
 */

const TEMPLATE_FIELD_KEY = 'output.template_id';

function option(
  key: string,
  label: string,
  metadata: Record<string, unknown> = {},
): PlannerConfigOption {
  return { key, label, metadata };
}

function config(fields: Record<string, readonly PlannerConfigOption[]>): PlannerConfigResponse {
  return { version: 4, published_at: '2026-08-28T00:00:00.000Z', fields };
}

/** 两套套件的正常配置，与迁移 0017 的内容对应 */
function published(): PlannerConfigResponse {
  return config({
    [TEMPLATE_FIELD_KEY]: [
      option('ink_paper_v1', '水墨纸本', {
        value_kind: 'ENUM',
        preview_image: '/images/templates/ink-paper-v1.png',
      }),
      option('blueprint_v1', '工程蓝图', {
        value_kind: 'ENUM',
        preview_image: '/images/templates/blueprint-v1.png',
      }),
    ],
  });
}

function render(
  value: PlannerConfigResponse | undefined,
  selected: Parameters<typeof TemplatePicker>[0]['selected'] = null,
): string {
  const dispatch = vi.fn<(action: PlannerAction) => void>();
  return renderToStaticMarkup(
    <PlannerConfigProvider {...(value === undefined ? {} : { value })}>
      <TemplatePicker selected={selected} dispatch={dispatch} />
    </PlannerConfigProvider>,
  );
}

describe('输出样式选择器', () => {
  it('渲出配置里每一套的示例图与中文名', () => {
    const html = render(published());

    expect(html).toContain('/images/templates/ink-paper-v1.png');
    expect(html).toContain('/images/templates/blueprint-v1.png');
    expect(html).toContain('水墨纸本');
    expect(html).toContain('工程蓝图');
  });

  it('展示名来自配置而不是硬编码', () => {
    /*
     * 运营改一次文案就该生效，不用发版。这条红的方式是「界面显示的仍是旧文案」——
     * 而那种缺陷在截图上看不出来，因为旧文案本身是合法的。
     */
    const html = render(
      config({
        [TEMPLATE_FIELD_KEY]: [
          option('ink_paper_v1', '宣纸淡墨', {
            value_kind: 'ENUM',
            preview_image: '/images/templates/ink-paper-v1.png',
          }),
        ],
      }),
    );

    expect(html).toContain('宣纸淡墨');
    expect(html).not.toContain('水墨纸本');
  });

  it('选中的那一张标 aria-pressed，其余不标', () => {
    const html = render(published(), 'blueprint_v1');

    /*
     * 逐段断言而不是数 `aria-pressed="true"` 出现几次：后者在两张都标 true 时
     * 也可能因为计数写错而通过，而这里要的是「哪一张被标了」。
     */
    const cards = html.split('<button').slice(1);
    expect(cards).toHaveLength(2);

    const ink = cards.find((card) => card.includes('ink-paper-v1.png'));
    const blueprint = cards.find((card) => card.includes('blueprint-v1.png'));

    expect(ink).toContain('aria-pressed="false"');
    expect(blueprint).toContain('aria-pressed="true"');
  });

  it('没有配置时整个区块不渲染', () => {
    /*
     * 首帧（配置还在拉）与拉失败都走这一支。**不回退到硬编码列表** ——
     * 硬编码列表里的图片地址会与配置漂移，而漂移的表现是碎图标，
     * 那看起来像「这个样式坏了」。什么也不显示时用户拿默认套件，
     * 与加这个功能之前完全一致。
     */
    expect(render(undefined)).toBe('');
    expect(render(config({}))).toBe('');
  });

  it('配置里缺示例图的那一行被丢掉', () => {
    /*
     * 只丢那一行而不是整个区块：另一套仍然可选。
     * 渲一个没有 `preview_image` 的卡片会得到 `<img src="">`，
     * 而浏览器对空 src 的处理是重新请求当前页面 —— 一个卡片变成一次多余的
     * 整页请求，且图位显示碎图标。
     */
    const html = render(
      config({
        [TEMPLATE_FIELD_KEY]: [
          option('ink_paper_v1', '水墨纸本', { value_kind: 'ENUM' }),
          option('blueprint_v1', '工程蓝图', {
            value_kind: 'ENUM',
            preview_image: '/images/templates/blueprint-v1.png',
          }),
        ],
      }),
    );

    expect(html).not.toContain('水墨纸本');
    expect(html).toContain('工程蓝图');
  });

  it('配置里代码不认的套件被丢掉', () => {
    /*
     * 「新套件先发了配置、前端还没上线」这个中间态。渲它的后果是用户选得中、
     * 提交被 `z.enum` 拒 —— 而那时错误信息指向 schema 校验而不指向配置，
     * 于是排查会从前端开始，而真因在配置中心。
     */
    const html = render(
      config({
        [TEMPLATE_FIELD_KEY]: [
          option('no_such_v1', '未来样式', {
            value_kind: 'ENUM',
            preview_image: '/images/templates/no-such-v1.png',
          }),
          option('ink_paper_v1', '水墨纸本', {
            value_kind: 'ENUM',
            preview_image: '/images/templates/ink-paper-v1.png',
          }),
        ],
      }),
    );

    expect(html).not.toContain('未来样式');
    expect(html).not.toContain('no-such-v1.png');
    expect(html).toContain('水墨纸本');
  });

  it('展示顺序跟随配置的顺序', () => {
    /*
     * `sort_order` 在服务端已排好（仓储的 ORDER BY），前端不得重排 ——
     * 重排的后果是运营调了顺序而界面不变，而那看起来像「配置没生效」。
     */
    const reversed = config({
      [TEMPLATE_FIELD_KEY]: [
        option('blueprint_v1', '工程蓝图', {
          value_kind: 'ENUM',
          preview_image: '/images/templates/blueprint-v1.png',
        }),
        option('ink_paper_v1', '水墨纸本', {
          value_kind: 'ENUM',
          preview_image: '/images/templates/ink-paper-v1.png',
        }),
      ],
    });

    const html = render(reversed);
    expect(html.indexOf('工程蓝图')).toBeLessThan(html.indexOf('水墨纸本'));
  });

  it('两套套件都能渲 —— 防止只验了默认那一套', () => {
    /*
     * 上面几条都显式写了两个 ID。这一条从枚举遍历：加了第三套套件而忘了
     * 补配置时，`template-catalog-coverage.test.ts` 会红；
     * 而这一条盯的是「配置有了，但组件渲不出来」。
     */
    const html = render(published());
    for (const templateId of TEMPLATE_ID_VALUES) {
      expect(html, `${templateId} 没渲出来`).toContain(templateId.replaceAll('_', '-'));
    }
  });
});
