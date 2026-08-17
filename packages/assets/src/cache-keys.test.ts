import { THEME_BUCKET_VALUES, type RouteNode } from '@tps/schemas';
import { describe, expect, it } from 'vitest';
import {
  KEY_VERSION,
  aspectRatioSegment,
  destinationSegment,
  foodCacheKey,
  heroCacheKey,
  mapCacheKey,
  placeCacheKey,
  routeNodeHash,
} from './cache-keys.js';
import { THEME_KEYWORDS, themeBucket } from './theme-buckets.js';

/**
 * 19.1 键归一化 + 19.2 键格式 + 12 个主题语义桶（TP-3-12）。
 *
 * 这些断言的价值在于**同一输入恒定产出同一键**。键不稳定不会报错，
 * 只会让缓存命中率悄悄趋近 0 —— 而那意味着每个用户都在花钱重新生成
 * 一张已经存在的 Hero。
 */

describe('主题语义桶', () => {
  it('19.1 的例子：「运河人文·古今交融」→ canal_culture', () => {
    expect(themeBucket('运河人文·古今交融')).toBe('canal_culture');
  });

  it.each([
    ['西湖初见·湖山入画', 'lake_scenery'],
    ['灵隐问禅·山径听泉', 'temple_heritage'],
    ['宋韵寻踪·南宋遗痕', 'temple_heritage'],
    ['龙井茶山·春水初沸', 'mountain_nature'],
    ['钱塘江畔·城市天际', 'modern_city'],
    ['河坊街小吃巡礼', 'food_street'],
    ['拙政园的一个下午', 'garden_classic'],
    ['西溪亲子乐园一日', 'family_park'],
    ['鼓浪屿海岸线', 'coastal'],
    ['良渚博物院与玉器', 'museum_art'],
    ['南浔古镇慢行', 'old_town'],
    ['武林夜景与灯光秀', 'night_view'],
  ])('「%s」→ %s', (theme, expected) => {
    expect(themeBucket(theme)).toBe(expected);
  });

  it('无法归类落 general', () => {
    expect(themeBucket('随便走走')).toBe('general');
    expect(themeBucket('')).toBe('general');
    expect(themeBucket(null)).toBe('general');
  });

  it('12 个桶各有关键词，且总数为 13（含 general）', () => {
    expect(THEME_BUCKET_VALUES).toHaveLength(13);
    for (const bucket of THEME_BUCKET_VALUES) {
      if (bucket === 'general') continue;
      expect(THEME_KEYWORDS[bucket].length).toBeGreaterThan(0);
    }
  });

  it('多桶命中时按命中字数取最高，且结果稳定', () => {
    // 「古镇运河人家」同时含 old_town（古镇）与 canal_culture（运河）
    const first = themeBucket('古镇运河人家');
    for (let i = 0; i < 5; i += 1) {
      expect(themeBucket('古镇运河人家')).toBe(first);
    }
    expect(THEME_BUCKET_VALUES).toContain(first);
  });

  it('归桶前先归一化：全角空格与括号补充不影响结果', () => {
    expect(themeBucket('运河人文（杭州段）')).toBe('canal_culture');
    expect(themeBucket('　运河人文　')).toBe('canal_culture');
  });

  it('关键词只在括号里时会被归一化剔除（19.1 第 4 步的既定行为）', () => {
    /*
     * 19.1 明确要求「去除括号及其内容」，因此「（运河）人文」只剩「人文」，
     * 落 general。这是既定行为而不是缺陷：括号内容是补充说明，
     * 而主题桶要的是主干语义。落 general 的后果只是复用面变宽。
     */
    expect(themeBucket('（运河）人文')).toBe('general');
  });
});

describe('键段归一化（19.1）', () => {
  it('目的地优先 place_id', () => {
    expect(destinationSegment({ placeId: 'cn-hangzhou', name: '杭州' })).toBe('cn_hangzhou');
    // place_id 缺失才退化为名称
    expect(destinationSegment({ placeId: null, name: '杭州' })).toBe('杭州');
    expect(destinationSegment({ placeId: '   ', name: '杭州' })).toBe('杭州');
    expect(destinationSegment({})).toBe('unknown');
  });

  it('比例 16:6 → 16x6', () => {
    expect(aspectRatioSegment('16:6')).toBe('16x6');
    expect(aspectRatioSegment('4:3')).toBe('4x3');
  });
});

describe('19.2 四类键格式', () => {
  it('hero 键六段', () => {
    const key = heroCacheKey({
      destinationPlaceId: 'cn-hangzhou',
      theme: '运河人文·古今交融',
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    expect(key).toBe(`hero:${KEY_VERSION}:cn_hangzhou:canal_culture:chinese_travel_editorial:16x6`);
    expect(key.split(':')).toHaveLength(6);
  });

  it('hero 键：同城同主题桶同风格同比例 → 同一个键（19.5 跨天跨用户复用的前提）', () => {
    const a = heroCacheKey({
      destinationPlaceId: 'cn-hangzhou',
      theme: '运河人文·古今交融',
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });
    const b = heroCacheKey({
      destinationPlaceId: 'cn-hangzhou',
      // 不同的措辞，同一个桶
      theme: '水巷慢行·运河旧事',
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    expect(a).toBe(b);
  });

  it('hero 键：不同主题桶 → 不同键', () => {
    const canal = heroCacheKey({
      destinationPlaceId: 'cn-hangzhou',
      theme: '运河人文',
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });
    const lake = heroCacheKey({
      destinationPlaceId: 'cn-hangzhou',
      theme: '西湖湖光',
      visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
      aspectRatio: '16:6',
    });

    expect(canal).not.toBe(lake);
  });

  it('place 键四段，且以 place_id 为主键段', () => {
    expect(
      placeCacheKey({
        placeId: 'hz-gongchen-bridge',
        role: 'DESTINATION_PHOTO',
        aspectRatio: '16:9',
      }),
    ).toBe(`place:${KEY_VERSION}:hz_gongchen_bridge:destination_photo:16x9`);
  });

  it('place 键：措辞不同的名称在有 place_id 时得到同一个键', () => {
    const a = placeCacheKey({
      placeId: 'hz-gongchen-bridge',
      entityName: '拱宸桥',
      role: 'DESTINATION_PHOTO',
      aspectRatio: '16:9',
    });
    const b = placeCacheKey({
      placeId: 'hz-gongchen-bridge',
      entityName: '拱宸桥历史街区',
      role: 'DESTINATION_PHOTO',
      aspectRatio: '16:9',
    });

    expect(a).toBe(b);
  });

  it('food 键五段', () => {
    expect(
      foodCacheKey({
        dishName: '葱包桧与小馄饨',
        cityPlaceId: 'cn-hangzhou',
        visualStyle: 'REALISTIC_FOOD_PHOTOGRAPHY',
      }),
    ).toBe(`food:${KEY_VERSION}:葱包桧与小馄饨:cn_hangzhou:realistic_food_photography`);
  });

  it('map 键四段', () => {
    const nodes: RouteNode[] = [
      { name: '拱宸桥', latitude: 30.3201, longitude: 120.1421 },
      { name: '大兜路', latitude: 30.3105, longitude: 120.1502 },
    ];
    const key = mapCacheKey({ nodes, style: 'CANAL_GREEN' });

    expect(key).toMatch(new RegExp(`^map:${KEY_VERSION}:[0-9a-f]{16}:canal_green$`));
  });
});

describe('route_node_hash（19.1 最后一行）', () => {
  const nodes: RouteNode[] = [
    { name: '拱宸桥', latitude: 30.3201, longitude: 120.1421 },
    { name: '大兜路', latitude: 30.3105, longitude: 120.1502 },
  ];

  it('16 位十六进制，且同输入同输出', () => {
    const hash = routeNodeHash(nodes);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(routeNodeHash(nodes)).toBe(hash);
  });

  it('坐标保留 4 位小数：第 5 位起的抖动不改变哈希', () => {
    /*
     * 这一条是缓存能命中的关键。模型两次输出 30.3201 与 30.32009999 时，
     * 不做四舍五入会得到两个键，同一条路线被画两次。
     */
    const jittered: RouteNode[] = [
      { name: '拱宸桥', latitude: 30.32009999, longitude: 120.14210001 },
      { name: '大兜路', latitude: 30.31050004, longitude: 120.15019998 },
    ];
    expect(routeNodeHash(jittered)).toBe(routeNodeHash(nodes));
  });

  it('第 4 位小数不同 → 哈希不同（约 11 米，是有意义的差异）', () => {
    const moved: RouteNode[] = [
      { name: '拱宸桥', latitude: 30.3205, longitude: 120.1421 },
      nodes[1]!,
    ];
    expect(routeNodeHash(moved)).not.toBe(routeNodeHash(nodes));
  });

  it('节点顺序影响哈希（换个顺序走就是另一条路线）', () => {
    expect(routeNodeHash([nodes[1]!, nodes[0]!])).not.toBe(routeNodeHash(nodes));
  });

  it('坐标非法的节点被剔除后再算哈希（与渲染器同口径）', () => {
    const withInvalid: RouteNode[] = [
      nodes[0]!,
      { name: '坏点', latitude: null, longitude: null },
      { name: '越界', latitude: 999, longitude: 999 },
      nodes[1]!,
    ];
    expect(routeNodeHash(withInvalid)).toBe(routeNodeHash(nodes));
  });

  it('名称参与哈希：同坐标不同名称 → 不同键（标签不同就是不同的图）', () => {
    const renamed: RouteNode[] = [{ ...nodes[0]!, name: '拱宸桥北' }, nodes[1]!];
    expect(routeNodeHash(renamed)).not.toBe(routeNodeHash(nodes));
  });
});
