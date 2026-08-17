import type { RouteNode } from '@tps/schemas';
import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH, escapeXml, renderSchematicMap } from './svg-map.js';
import { routeNodeHash } from './cache-keys.js';

/**
 * 路线示意图渲染（TP-3-10）。
 */

const hangzhou: RouteNode[] = [
  { name: '拱宸桥', latitude: 30.3201, longitude: 120.1421 },
  { name: '中国大运河博物馆', latitude: 30.3186, longitude: 120.1465 },
  { name: '桥西直街', latitude: 30.3178, longitude: 120.1439 },
  { name: '大兜路', latitude: 30.3105, longitude: 120.1502 },
];

function render(nodes: readonly RouteNode[]) {
  return renderSchematicMap({ nodes, style: 'CANAL_GREEN' });
}

describe('正常渲染', () => {
  it('产出 viewBox 尺寸与节点数（8.2 的 metadata）', () => {
    const result = render(hangzhou);
    expect(result.kind).toBe('rendered');
    if (result.kind !== 'rendered') return;

    expect(result.map.width).toBe(MAP_WIDTH);
    expect(result.map.height).toBe(MAP_HEIGHT);
    expect(result.map.nodeCount).toBe(4);
    expect(result.map.routeNodeHash).toBe(routeNodeHash(hangzhou));
    expect(result.map.svg).toContain(`viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}"`);
  });

  it('节点按顺序连成折线，且每个节点有序号与名称', () => {
    const result = render(hangzhou);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');

    expect(result.map.svg).toContain('<polyline');
    for (const node of hangzhou) {
      expect(result.map.svg).toContain(node.name);
    }
    // 序号 1..4
    for (const index of [1, 2, 3, 4]) {
      expect(result.map.svg).toContain(`>${index}</text>`);
    }
  });

  it('不含任何外部引用（PDF 导出时外部资源加载失败是静默的）', () => {
    const result = render(hangzhou);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');

    expect(result.map.svg).not.toContain('<image');
    expect(result.map.svg).not.toContain('xlink:href');
    expect(result.map.svg).not.toContain('@import');
    expect(result.map.svg).not.toContain('<script');
    expect(result.map.svg).not.toContain('<use');

    /*
     * `xmlns="http://www.w3.org/2000/svg"` 是命名空间声明而不是资源引用 ——
     * 渲染器不会去请求它。因此剔掉它之后再断言没有任何 URL。
     */
    const withoutNamespace = result.map.svg.replace(/xmlns(:\w+)?="[^"]*"/g, '');
    expect(withoutNamespace).not.toMatch(/https?:\/\//);
  });

  it('全部坐标落在画布内', () => {
    const result = render(hangzhou);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');

    const coords = [...result.map.svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)];
    expect(coords.length).toBeGreaterThan(0);
    for (const [, x, y] of coords) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(x)).toBeLessThanOrEqual(MAP_WIDTH);
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(MAP_HEIGHT);
    }
  });

  it('同输入产出完全相同的 SVG（内容寻址的前提）', () => {
    const a = render(hangzhou);
    const b = render(hangzhou);
    if (a.kind !== 'rendered' || b.kind !== 'rendered') throw new Error('应当渲染成功');
    expect(a.map.svg).toBe(b.map.svg);
  });
});

describe('坐标非法与节点不足', () => {
  it('坐标为 null 的节点被剔除（V-08 的修复结果）', () => {
    const withNull: RouteNode[] = [
      hangzhou[0]!,
      { name: '缺坐标的点', latitude: null, longitude: null },
      hangzhou[1]!,
    ];

    const result = render(withNull);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');
    expect(result.map.nodeCount).toBe(2);
    expect(result.map.svg).not.toContain('缺坐标的点');
  });

  it.each([
    ['纬度越界', { name: '坏点', latitude: 91, longitude: 120 }],
    ['经度越界', { name: '坏点', latitude: 30, longitude: 181 }],
    ['纬度为 NaN', { name: '坏点', latitude: Number.NaN, longitude: 120 }],
  ])('%s 的节点被剔除', (_label, bad) => {
    const result = render([hangzhou[0]!, bad, hangzhou[1]!]);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');
    expect(result.map.nodeCount).toBe(2);
    expect(result.map.svg).not.toContain('坏点');
  });

  it('有效节点少于 2 个不出图（模板改用文字列表）', () => {
    expect(render([hangzhou[0]!])).toEqual({ kind: 'insufficient_nodes', validNodes: 1 });
    expect(render([])).toEqual({ kind: 'insufficient_nodes', validNodes: 0 });
    expect(
      render([
        { name: '只有一个有效点', latitude: 30, longitude: 120 },
        { name: '坏点', latitude: null, longitude: null },
      ]),
    ).toEqual({ kind: 'insufficient_nodes', validNodes: 1 });
  });

  it('全部节点同一坐标时不产生 NaN（跨度为 0 的除零）', () => {
    const same: RouteNode[] = [
      { name: 'A', latitude: 30, longitude: 120 },
      { name: 'B', latitude: 30, longitude: 120 },
    ];

    const result = render(same);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');
    expect(result.map.svg).not.toContain('NaN');
    expect(result.map.svg).not.toContain('Infinity');
  });

  it('同纬度不同经度（跨度一轴为 0）也不产生 NaN', () => {
    const line: RouteNode[] = [
      { name: 'A', latitude: 30, longitude: 120 },
      { name: 'B', latitude: 30, longitude: 120.05 },
    ];

    const result = render(line);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');
    expect(result.map.svg).not.toContain('NaN');
  });
});

describe('转义', () => {
  it('节点名里的尖括号与引号被转义（LLM 输出当作不可信文本）', () => {
    expect(escapeXml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('渲染结果里不出现未转义的标签', () => {
    const result = render([
      { name: '<b>拱宸桥</b>', latitude: 30.32, longitude: 120.14 },
      { name: '大兜路 & 小河直街', latitude: 30.31, longitude: 120.15 },
    ]);
    if (result.kind !== 'rendered') throw new Error('应当渲染成功');

    expect(result.map.svg).not.toContain('<b>');
    expect(result.map.svg).toContain('&lt;b&gt;');
    expect(result.map.svg).toContain('&amp;');
  });
});
