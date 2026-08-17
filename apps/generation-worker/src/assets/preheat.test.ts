import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AiAssetGenerateRequestSchema, THEME_BUCKET_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { PREHEAT_CONCURRENCY, describeError, parsePreheatArgs } from './preheat-cli.js';
import { HERO_ASPECT_RATIO, parsePreheatManifest, preheatTargets } from './preheat.js';

/**
 * 19.5 Hero 预热（TP-4-05）。
 *
 * 预热的目的是「绝大多数请求的 Hero 走缓存命中（毫秒级）而非实时生成
 * （10～40 秒）」—— 21.2 的 T2 目标就建立在它之上。因此这一组断言真正要
 * 守住的是**预热产出的键与在线请求算出的键相同**：
 * 键对不上不会报错，只会让 600 张图躺在库里没人命中，
 * 而缓存命中率指标如实显示 0、却看不出原因。
 */

describe('目标枚举', () => {
  const destinations = [
    { place_id: 'cn_hangzhou', name: '杭州' },
    { place_id: 'cn_suzhou', name: '苏州' },
  ];

  it('目的地 × 13 个桶（12 个具体桶 + general）', () => {
    const targets = preheatTargets(destinations);
    expect(targets).toHaveLength(destinations.length * THEME_BUCKET_VALUES.length);
    expect(THEME_BUCKET_VALUES).toContain('general');
  });

  it('general 桶也预热 —— 它是关键词未命中时的落点（R-27）', () => {
    const targets = preheatTargets(destinations);
    expect(targets.some((target) => target.bucket === 'general')).toBe(true);
  });

  it('缓存键各不相同，且与在线请求同一格式（19.2）', () => {
    const targets = preheatTargets(destinations);
    const keys = targets.map((target) => target.cacheKey);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      // hero:v1:{destination}:{bucket}:{style}:{16x6}
      expect(key).toMatch(/^hero:v1:[^:]+:[a-z_]+:chinese_travel_editorial:16x6$/);
    }
  });

  it('键含 place_id 而不是名称（19.1 优先用 place_id）', () => {
    const [target] = preheatTargets([destinations[0]!]);
    expect(target?.cacheKey).toContain('cn_hangzhou');
    expect(target?.cacheKey).not.toContain('杭州');
  });

  it('请求体符合 14.3 契约，且是 Hero 的画幅', () => {
    for (const target of preheatTargets(destinations)) {
      expect(AiAssetGenerateRequestSchema.safeParse(target.request).success).toBe(true);
      expect(target.request.asset_type).toBe('HERO_ILLUSTRATION');
      expect(target.request.brief.layout.aspect_ratio).toBe(HERO_ASPECT_RATIO);
      // Hero 要留左上角文字区（12.1 的标题压在那里）
      expect(target.request.brief.layout.reserved_text_area).toBe('LEFT_TOP');
    }
  });

  it('不写死具体元素 —— 预热图要服务于该桶下的任意行程', () => {
    for (const target of preheatTargets(destinations)) {
      expect(target.request.brief.elements).toEqual([]);
    }
  });

  it('19.5 的规模：50 个目的地 → 650 个目标', () => {
    const fifty = Array.from({ length: 50 }, (_unused, index) => ({
      place_id: `cn_city_${index}`,
      name: `城市${index}`,
    }));
    expect(preheatTargets(fifty)).toHaveLength(650);
  });
});

describe('清单解析', () => {
  it('跳过空行与注释', () => {
    const result = parsePreheatManifest(
      ['# 注释', '', '{ "place_id": "cn_hangzhou", "name": "杭州" }'].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.destinations).toHaveLength(1);
  });

  it('收集全部错行，而不是在第一处停下', () => {
    const result = parsePreheatManifest(
      ['not json', '{ "place_id": "", "name": "x" }', '{ "name": "缺 place_id" }'].join('\n'),
    );
    expect(result.errors).toHaveLength(3);
    expect(result.destinations).toHaveLength(0);
  });

  it('place_id 重复报错（否则「预热了多少」这个数字会失真）', () => {
    const line = '{ "place_id": "cn_hangzhou", "name": "杭州" }';
    const result = parsePreheatManifest([line, line].join('\n'));
    expect(result.errors).toHaveLength(1);
    expect(result.destinations).toHaveLength(1);
  });

  it('仓库里的示例清单本身合法', async () => {
    const file = path.resolve(
      import.meta.dirname,
      '../../../../infrastructure/seed/preheat-destinations.example.jsonl',
    );
    const result = parsePreheatManifest(await readFile(file, 'utf8'));
    expect(result.errors).toEqual([]);
    expect(result.destinations.length).toBeGreaterThan(0);
  });
});

describe('CLI 参数', () => {
  it('--manifest 必填', () => {
    expect(() => parsePreheatArgs([])).toThrow(/--manifest/);
    expect(() => parsePreheatArgs(['--manifest'])).toThrow(/文件路径/);
  });

  it('--dry-run 与 --limit', () => {
    expect(parsePreheatArgs(['--manifest', 'a.jsonl', '--dry-run', '--limit', '10'])).toEqual({
      manifest: 'a.jsonl',
      dryRun: true,
      limit: 10,
    });
  });

  it('--limit 必须是正整数', () => {
    expect(() => parsePreheatArgs(['--manifest', 'a.jsonl', '--limit', '0'])).toThrow(/正整数/);
    expect(() => parsePreheatArgs(['--manifest', 'a.jsonl', '--limit', 'x'])).toThrow(/正整数/);
  });

  it('未知参数报错（打错的参数会静默不生效，比如把 --dry-run 拼成 --dryrun）', () => {
    expect(() => parsePreheatArgs(['--manifest', 'a.jsonl', '--dryrun'])).toThrow(/未知参数/);
  });

  it('并发低于 21.2 的在线全局并发（预热不该挤占在线请求）', () => {
    expect(PREHEAT_CONCURRENCY).toBeLessThan(20);
  });
});

describe('pnpm 的参数分隔符', () => {
  it('忽略裸 `--`（`pnpm assets:preheat -- --dry-run` 会把它传进来）', () => {
    expect(parsePreheatArgs(['--', '--manifest', 'a.jsonl', '--dry-run'])).toEqual({
      manifest: 'a.jsonl',
      dryRun: true,
      limit: null,
    });
  });
});

describe('错误说明', () => {
  it('AggregateError 带出首个原因（S3 连不上时抛的正是它）', () => {
    const error = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:9000')],
      'all attempts failed',
    );
    const text = describeError(error);
    expect(text).toContain('AggregateError');
    expect(text).toContain('ECONNREFUSED');
  });

  it('带 cause 的普通错误也展开一层', () => {
    const text = describeError(new Error('上传失败', { cause: new Error('403 Forbidden') }));
    expect(text).toContain('403 Forbidden');
  });

  it('非 Error 值原样字符串化', () => {
    expect(describeError('boom')).toBe('boom');
  });
});
