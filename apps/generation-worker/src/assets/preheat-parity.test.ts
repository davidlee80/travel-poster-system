import { THEME_BUCKET_VALUES, type AssetRequirementItem } from '@tps/schemas';
import { themeBucket } from '@tps/assets';
import { describe, expect, it } from 'vitest';

import {
  BUCKET_THEME_PHRASE,
  HERO_ASPECT_RATIO,
  HERO_MIN_WIDTH,
  preheatTargets,
} from './preheat.js';
import { cacheKeyFor } from './resolve-assets.js';

/**
 * 预热键与运行时键必须逐字符相同。
 *
 * ## 这个测试防的是什么
 *
 * 预热侧（`preheatTargets`）与运行时侧（`cacheKeyFor`）各自拼一份 Hero 缓存键。
 * 两边读的字段、给的默认值、用的画幅一旦错开，650 张预热图就**全部命不中** ——
 * 而失效的表现只是 `travel_asset_cache_hit_ratio` 为 0，看不出原因。
 * `preheat.ts` 的文件头把这件事列为头号风险。
 *
 * `preheat.test.ts` 里已有一条正则断言键的**形状**
 * （`/^hero:v1:[^:]+:[a-z_]+:chinese_travel_editorial:16x6$/`），但形状对不等于值对：
 * 桶名算错、画幅取错、风格默认值不同，那条正则一样通过。
 *
 * 因此这里比的是两个函数的**输出**，而不是各自的格式。
 *
 * ## 为什么不在测试里重拼一遍键
 *
 * 直接调 `heroCacheKey` 与预热比是同义反复 —— 两边都调同一个函数，必然相等，
 * 而真正会漂移的是「`cacheKeyFor` 从 `subject` 读了哪几个字段、
 * `visual_constraints` 缺 `style` 时补什么」。所以必须过 `cacheKeyFor` 本身。
 */

const DESTINATION = { place_id: 'cn_hangzhou', name: '杭州' } as const;

/**
 * 构造一个运行时形态的 Hero 需求项。
 *
 * 字段取值对齐 `packages/presentation` 的槽位生成：画幅 16:6、最小宽度 1600、
 * `style` **不给**（运行时 Hero 需求确实不带它，靠 `cacheKeyFor` 的默认值补）。
 * 这一点是刻意的：如果哪天默认值从 `CHINESE_TRAVEL_EDITORIAL` 改掉，
 * 这个测试要红。
 */
function heroRequirement(theme: string): AssetRequirementItem {
  return {
    slot_id: 'day_1.hero_background',
    role: 'HERO_BACKGROUND',
    required: true,
    subject: {
      destination: DESTINATION.name,
      destination_place_id: DESTINATION.place_id,
      theme,
    },
    visual_constraints: {
      aspect_ratio: HERO_ASPECT_RATIO,
      min_width: HERO_MIN_WIDTH,
    },
  } as AssetRequirementItem;
}

describe('预热键 ↔ 运行时键一致性', () => {
  it('13 个桶的代表短语走运行时算出的键，与预热枚举的键完全相同', () => {
    const targets = preheatTargets([DESTINATION]);
    expect(targets).toHaveLength(THEME_BUCKET_VALUES.length);

    for (const target of targets) {
      /*
       * 真实请求带的是 LLM 生成的中文主题短语，运行时先归桶再进键。
       * 用该桶的代表短语模拟：它是预热时送给模型的那一句，
       * 因此「该短语的真实请求」必须命中为它预热的那张图。
       */
      const phrase = BUCKET_THEME_PHRASE[target.bucket];
      const runtimeKey = cacheKeyFor(heroRequirement(phrase));

      expect(runtimeKey, `桶 ${target.bucket} 的键对不上`).toBe(target.cacheKey);
    }
  });

  it('每个代表短语都归到它自己的桶', () => {
    /*
     * 这一条与上一条不同：上一条比的是键，而键里的桶名是预热**显式**传进去的
     * （`preheatTargets` 直接枚举桶，不经 `themeBucket`）。所以上一条能过，
     * 却不保证「用户输入这个短语时会落到这个桶」。
     *
     * 不成立的后果是内容错配而不是键错配：为 night_view 预热的那张图，
     * 是用一句实际归到别的桶的短语生成的 —— 键命中，画面不对题。
     */
    for (const bucket of THEME_BUCKET_VALUES) {
      const phrase = BUCKET_THEME_PHRASE[bucket];
      expect(themeBucket(phrase), `短语「${phrase}」没有归到 ${bucket}`).toBe(bucket);
    }
  });

  it('缺 place_id 时两侧同样退化到归一化名称', () => {
    /*
     * `travel-request.ts` 明确 `place_id` 是可选的。前端不送时运行时键用归一化
     * 目的地名，因此预热清单也必须用同一个值 —— 否则一侧是 `cn_hangzhou`、
     * 另一侧是 `杭州`，两者永远不会互相命中。
     */
    const nameOnly = { place_id: '杭州', name: '杭州' } as const;
    const [target] = preheatTargets([nameOnly], ['canal_culture']);

    const runtimeKey = cacheKeyFor({
      ...heroRequirement(BUCKET_THEME_PHRASE.canal_culture),
      subject: { destination: '杭州', theme: BUCKET_THEME_PHRASE.canal_culture },
    });

    expect(runtimeKey).toBe(target?.cacheKey);
    expect(runtimeKey).toContain('杭州');
  });

  it('运行时给了显式 style 时键随之变化（说明键真的读了这个字段）', () => {
    /*
     * 反证：把 `style` 显式写成美食风格，键必须变。
     * 不变意味着 `cacheKeyFor` 忽略了 `visual_constraints.style`，
     * 那么上面那条「默认值一致」的断言其实什么都没验到。
     */
    const base = heroRequirement(BUCKET_THEME_PHRASE.canal_culture);
    const withStyle: AssetRequirementItem = {
      ...base,
      visual_constraints: { ...base.visual_constraints, style: 'REALISTIC_FOOD_PHOTOGRAPHY' },
    };

    expect(cacheKeyFor(withStyle)).not.toBe(cacheKeyFor(base));
    expect(cacheKeyFor(withStyle)).toContain('realistic_food_photography');
  });

  it('运行时换了画幅键也变（14.3 的槽位约束是键的一部分）', () => {
    const base = heroRequirement(BUCKET_THEME_PHRASE.lake_scenery);
    const wideKey = cacheKeyFor({
      ...base,
      visual_constraints: { ...base.visual_constraints, aspect_ratio: '16:9' },
    });

    expect(wideKey).not.toBe(cacheKeyFor(base));
    expect(wideKey).toContain('16x9');
  });
});

describe('预热覆盖的假设', () => {
  it('桶集合就是 THEME_BUCKET_VALUES，没有漏也没有多', () => {
    const buckets = preheatTargets([DESTINATION]).map((target) => target.bucket);
    expect([...buckets].sort()).toEqual([...THEME_BUCKET_VALUES].sort());
  });

  it('BUCKET_THEME_PHRASE 覆盖全部桶（新增桶时这里会红）', () => {
    for (const bucket of THEME_BUCKET_VALUES) {
      const phrase: string | undefined = BUCKET_THEME_PHRASE[bucket];
      expect(phrase, `桶 ${bucket} 缺代表短语`).toBeTruthy();
    }
  });
});
