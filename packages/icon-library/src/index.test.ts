import { describe, expect, it } from 'vitest';
import {
  MODULE_ICON_KEYS,
  PERIOD_VALUES,
  TRANSPORT_MODE_VALUES,
  type Period,
  type TransportMode,
} from '@tps/schemas';
import { MODULE_ICON_PATHS, periodIconName, transportIconName } from '@tps/presentation';
import {
  ALL_ICON_NAMES,
  ICON_PATHS,
  MODULE_ICON_BY_KEY,
  PERIOD_ICON_BY_ENUM,
  TRANSPORT_ICON_BY_ENUM,
  iconMarkup,
  isIconName,
  resolveIconName,
} from './index.js';

/**
 * 图标库测试（TP-1-03，设计稿 9.1、验收标准 5）。
 *
 * 最重要的一组断言是**跨模块一致性**：
 *   9.1 的图标文件  ↔  12.1 的图标名派生规则  ↔  12.2 的 icons 字段路径
 * 这三处任一漂移都会导致页面上缺图标，而缺一个图标就违反验收标准 5。
 * 单看任何一个模块的测试都发现不了漂移，必须在这里交叉验证。
 */

describe('9.1 图标清单', () => {
  it('恰好 19 个图标（8 模块 + 5 时段 + 6 交通）', () => {
    expect(ALL_ICON_NAMES).toHaveLength(19);
  });

  it('每个图标都有非空内容', () => {
    for (const name of ALL_ICON_NAMES) {
      expect(ICON_PATHS[name], name).toMatch(/\S/);
    }
  });

  it('图标内容不含外部引用、脚本、文字或字体依赖（离线渲染与 PDF 导出的前提）', () => {
    for (const name of ALL_ICON_NAMES) {
      const body = ICON_PATHS[name];
      expect(body, name).not.toMatch(/<image/i);
      expect(body, name).not.toMatch(/<script/i);
      expect(body, name).not.toMatch(/<text/i);
      expect(body, name).not.toMatch(/font-family/i);
      expect(body, name).not.toMatch(/url\(/i);
      expect(body, name).not.toMatch(/https?:/i);
    }
  });
});

describe('跨模块一致性（9.1 ↔ 12.1 ↔ 12.2）', () => {
  it('12.2 的 8 个模块键在图标库中都有对应文件', () => {
    for (const key of MODULE_ICON_KEYS) {
      const iconName = MODULE_ICON_BY_KEY[key];
      expect(isIconName(iconName), `模块键 ${key} 映射到不存在的图标 ${iconName}`).toBe(true);
    }
  });

  it('12.2 的 icons 路径能被解析回图标名（路径形态与名称形态互通）', () => {
    for (const key of MODULE_ICON_KEYS) {
      const pathValue = MODULE_ICON_PATHS[key];
      const resolved = resolveIconName(pathValue);

      expect(resolved, `路径 ${pathValue} 无法解析`).not.toBeNull();
      expect(resolved).toBe(MODULE_ICON_BY_KEY[key]);
    }
  });

  it('12.1 的时段图标名派生规则与图标文件一一对应', () => {
    for (const period of PERIOD_VALUES) {
      const derived = periodIconName(period);
      expect(isIconName(derived), `派生名 ${derived} 无对应文件`).toBe(true);
      expect(derived).toBe(PERIOD_ICON_BY_ENUM[period]);
    }
  });

  it('12.1 的交通图标名派生规则与图标文件一一对应', () => {
    for (const mode of TRANSPORT_MODE_VALUES) {
      const derived = transportIconName(mode);
      expect(isIconName(derived), `派生名 ${derived} 无对应文件`).toBe(true);
      expect(derived).toBe(TRANSPORT_ICON_BY_ENUM[mode]);
    }
  });

  it('设计稿 V1.0 的 sun-morning 不存在（按原值实现会导致查找失败）', () => {
    expect(isIconName('sun-morning')).toBe(false);
    expect(isIconName('period-morning')).toBe(true);
  });

  it('19 个图标全部被三张映射表覆盖，无孤儿图标', () => {
    const referenced = new Set<string>([
      ...MODULE_ICON_KEYS.map((k) => MODULE_ICON_BY_KEY[k]),
      ...PERIOD_VALUES.map((p) => PERIOD_ICON_BY_ENUM[p]),
      ...TRANSPORT_MODE_VALUES.map((m) => TRANSPORT_ICON_BY_ENUM[m]),
    ]);

    expect(referenced.size).toBe(19);
    for (const name of ALL_ICON_NAMES) {
      expect(referenced.has(name), `图标 ${name} 未被任何映射引用`).toBe(true);
    }
  });
});

describe('图标名解析', () => {
  it('接受名称形态', () => {
    expect(resolveIconName('calendar')).toBe('calendar');
    expect(resolveIconName('period-night')).toBe('period-night');
  });

  it('接受路径形态', () => {
    expect(resolveIconName('/icons/travel/calendar.svg')).toBe('calendar');
    expect(resolveIconName('calendar.svg')).toBe('calendar');
  });

  it('未知引用返回 null 而不是兜底图标（缺图标应在构建期发现，不该运行期静默替换）', () => {
    expect(resolveIconName('nonexistent')).toBeNull();
    expect(resolveIconName('/icons/travel/nope.svg')).toBeNull();
    expect(resolveIconName('')).toBeNull();
  });
});

describe('SVG 标记生成', () => {
  it('产出完整自包含的 svg 元素', () => {
    const markup = iconMarkup('calendar');

    expect(markup).toMatch(/^<svg /);
    expect(markup).toMatch(/<\/svg>$/);
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke="currentColor"');
  });

  it('默认为装饰性图标（aria-hidden），无标题', () => {
    const markup = iconMarkup('food');

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('<title>');
  });

  it('提供 title 时改为 role="img" 并输出标题', () => {
    const markup = iconMarkup('food', { title: '美食' });

    expect(markup).toContain('role="img"');
    expect(markup).toContain('<title>美食</title>');
    expect(markup).not.toContain('aria-hidden');
  });

  it('标题中的特殊字符被转义（防止破坏 SVG 结构）', () => {
    const markup = iconMarkup('map', { title: '<地图 & "路线">' });

    expect(markup).toContain('&lt;地图 &amp; &quot;路线&quot;&gt;');
    expect(markup).not.toContain('<地图');
  });

  it('尺寸与类名可控', () => {
    const markup = iconMarkup('ticket', { size: 32, className: 'tps-icon' });

    expect(markup).toContain('width="32"');
    expect(markup).toContain('height="32"');
    expect(markup).toContain('class="tps-icon"');
  });

  it('全部 19 个图标都能生成合法标记', () => {
    for (const name of ALL_ICON_NAMES) {
      const markup = iconMarkup(name);
      // 标签配对：<svg> 开闭各一次
      expect((markup.match(/<svg /g) ?? []).length, name).toBe(1);
      expect((markup.match(/<\/svg>/g) ?? []).length, name).toBe(1);
    }
  });
});

describe('穷尽映射（编译期护栏的运行期确认）', () => {
  it('每个 Period 都有图标（漏配是编译错误，此处确认非空）', () => {
    const periods: Period[] = [...PERIOD_VALUES];
    for (const p of periods) {
      expect(PERIOD_ICON_BY_ENUM[p]).toMatch(/\S/);
    }
  });

  it('每个 TransportMode 都有图标', () => {
    const modes: TransportMode[] = [...TRANSPORT_MODE_VALUES];
    for (const m of modes) {
      expect(TRANSPORT_ICON_BY_ENUM[m]).toMatch(/\S/);
    }
  });

  it('映射值互不重复（重复会让两类条目在页面上无法区分）', () => {
    const periodIcons = PERIOD_VALUES.map((p) => PERIOD_ICON_BY_ENUM[p]);
    expect(new Set(periodIcons).size).toBe(periodIcons.length);

    const transportIcons = TRANSPORT_MODE_VALUES.map((m) => TRANSPORT_ICON_BY_ENUM[m]);
    expect(new Set(transportIcons).size).toBe(transportIcons.length);
  });
});
