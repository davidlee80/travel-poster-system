import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_ENTITY_SCORE,
  NEUTRAL_QUALITY_SCORE,
  SCORE_WEIGHTS,
  aspectRatioScore,
  destinationMatch,
  entityMatch,
  licenseScore,
  qualityScore,
  resolutionScore,
  scoreAsset,
  semanticQueryText,
  semanticSimilarity,
  type ScoringCandidate,
  type ScoringRequirement,
} from './scoring.js';
import { jaccard, normalizeKeySegment, normalizeName, tokenize } from './normalize.js';

/**
 * 10.1 的七个子函数（TP-3-07）。每个函数独立断言，包括各自的边界。
 */

function requirement(overrides: Partial<ScoringRequirement> = {}): ScoringRequirement {
  return {
    role: 'DESTINATION_PHOTO',
    entityName: '拱宸桥',
    entityPlaceId: 'hz-gongchen-bridge',
    destinationName: '杭州',
    destinationPlaceId: 'cn-hangzhou',
    aspectRatio: '16:9',
    minWidth: 800,
    ...overrides,
  };
}

function candidate(overrides: Partial<ScoringCandidate> = {}): ScoringCandidate {
  return {
    assetId: 'asset-1',
    entityName: '拱宸桥',
    destinationName: '杭州',
    destinationPlaceId: 'cn-hangzhou',
    width: 1200,
    aspectRatio: 16 / 9,
    qualityScore: 0.8,
    licenseType: 'PLATFORM_OWNED',
    attributionRequired: false,
    cosine: 0.6,
    ...overrides,
  };
}

describe('归一化（19.1，评分与缓存键共用）', () => {
  it('去空白、全角转半角、去括号内容、小写拉丁', () => {
    expect(normalizeName('  拱宸桥（运河段） ')).toBe('拱宸桥');
    expect(normalizeName('Ｗｅｓｔ Ｌａｋｅ')).toBe('westlake');
    expect(normalizeName('West Lake [北山街]')).toBe('westlake');
  });

  it('键段用下划线连接，且不含冒号（否则会把键切成不定段数）', () => {
    expect(normalizeKeySegment('葱包桧与小馄饨')).toBe('葱包桧与小馄饨');
    expect(normalizeKeySegment('West Lake · Night')).toBe('west_lake_night');
    expect(normalizeKeySegment('a:b:c')).toBe('a_b_c');
    expect(normalizeKeySegment('   ')).toBe('');
  });

  it('中文按 bigram 分词，单字保留', () => {
    expect(tokenize('博物馆')).toEqual(['博物', '物馆']);
    expect(tokenize('桥')).toEqual(['桥']);
    expect(tokenize('west lake')).toEqual(['west', 'lake']);
  });

  it('Jaccard 空集判 0（无信息不等于完全匹配）', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], ['a'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
  });
});

describe('entity_match（权重 0.35）', () => {
  it('完全相等 → 1.00', () => {
    expect(entityMatch(requirement(), candidate())).toBe(1);
  });

  it('归一化后相等（括号与全角差异）→ 1.00', () => {
    expect(entityMatch(requirement({ entityName: '拱宸桥（运河段）' }), candidate())).toBe(1);
  });

  it('别名命中 → 0.90，且优先于子串的 0.85', () => {
    /*
     * 「大运河博物馆」既是「中国大运河博物馆」的子串，也是它的别名。
     * 顺序判定会给 0.85；10.1 的表要求别名档是 0.90，
     * 因此实现取各档的最大值而不是先匹配先返回。
     */
    const score = entityMatch(
      requirement({ entityName: '大运河博物馆' }),
      candidate({ entityName: '中国大运河博物馆' }),
    );
    expect(score).toBe(0.9);
  });

  it('单纯子串 → 0.85', () => {
    expect(
      entityMatch(
        requirement({ entityName: '大兜路' }),
        candidate({ entityName: '大兜路历史街区' }),
      ),
    ).toBe(0.85);
  });

  it('分词 Jaccard ≥ 0.6 → 0.70', () => {
    // 「运河博物院」与「运河博物馆」：bigram 交集 运河/河博/博物 = 3，并集 5
    const score = entityMatch(
      requirement({ entityName: '运河博物馆' }),
      candidate({ entityName: '运河博物院' }),
    );
    expect(score).toBe(0.7);
  });

  it('毫不相关 → 0.00', () => {
    expect(entityMatch(requirement(), candidate({ entityName: '灵隐寺' }))).toBe(0);
  });

  it('需求缺 entity_name（Hero）→ 0.5 中性值', () => {
    /*
     * 这一条是 10.1 明确写出的：不给中性值的话，权重最大的一项归零，
     * Hero 的 final_score 上限只有 0.65，永远走不到素材库 ——
     * 而 Hero 恰恰是最贵的一张图（AI 实时生成 10～40 秒）。
     */
    expect(
      entityMatch(requirement({ role: 'HERO_BACKGROUND', entityName: null }), candidate()),
    ).toBe(NEUTRAL_ENTITY_SCORE);
  });

  it('素材缺 entity_name 但需求有 → 0.00（不是中性值）', () => {
    // 需求要「拱宸桥」，素材不知道自己拍的是什么 —— 这不是「无所谓」，
    // 而是「无法确认」，给中性值会让无标注素材优先于标注不同实体的素材
    expect(entityMatch(requirement(), candidate({ entityName: null }))).toBe(0);
  });
});

describe('destination_match（权重 0.20）', () => {
  it('place_id 相等 → 1.00', () => {
    expect(destinationMatch(requirement(), candidate())).toBe(1);
  });

  it('名称归一化相等 → 0.95', () => {
    expect(
      destinationMatch(
        requirement({ destinationPlaceId: null }),
        candidate({ destinationPlaceId: null }),
      ),
    ).toBe(0.95);
  });

  it('同省 → 0.50', () => {
    expect(
      destinationMatch(
        requirement({ destinationName: '杭州', destinationPlaceId: 'cn-hangzhou' }),
        candidate({ destinationName: '绍兴', destinationPlaceId: 'cn-shaoxing' }),
      ),
    ).toBe(0.5);
  });

  it('不同省 → 0.00', () => {
    expect(
      destinationMatch(
        requirement(),
        candidate({ destinationName: '成都', destinationPlaceId: 'cn-chengdu' }),
      ),
    ).toBe(0);
  });

  it('区划表外的城市 → 0.00（保守方向，不猜）', () => {
    expect(
      destinationMatch(
        requirement({ destinationName: '某县城', destinationPlaceId: 'cn-unknown' }),
        candidate({ destinationName: '另一个县城', destinationPlaceId: 'cn-other' }),
      ),
    ).toBe(0);
  });
});

describe('semantic_similarity（权重 0.20）', () => {
  it.each([
    [1, 1],
    [0, 0.5],
    [-1, 0],
    [0.6, 0.8],
  ])('余弦 %f → %f', (cosine, expected) => {
    expect(semanticSimilarity(candidate({ cosine }))).toBeCloseTo(expected, 6);
  });

  it('素材未向量化 → 中性 0.5（不是 0）', () => {
    // 记 0 会让未向量化素材的上限降到 0.8，几乎必然低于 0.65 阈值 ——
    // 等于把它们从库里删掉，而它们只是缺一次离线计算
    expect(semanticSimilarity(candidate({ cosine: null }))).toBe(NEUTRAL_QUALITY_SCORE);
  });

  it('查询文本含实体、目的地、角色中文名与风格标签（10.1）', () => {
    expect(
      semanticQueryText({
        role: 'FOOD_IMAGE',
        entityName: '片儿川',
        destination: '杭州',
        styleTags: ['noodle', 'bowl'],
      }),
    ).toBe('片儿川 杭州 美食图 noodle bowl');
  });

  it('查询文本跳过缺省项，不留空段', () => {
    expect(semanticQueryText({ role: 'HERO_BACKGROUND', destination: '杭州' })).toBe(
      '杭州 主题氛围插画',
    );
  });
});

describe('aspect_ratio_score（权重 0.10）', () => {
  it('完全一致 → 1.00', () => {
    expect(aspectRatioScore(requirement(), candidate())).toBe(1);
  });

  it('偏差半个八度（1.41 倍）→ 0.00', () => {
    const req = requirement({ aspectRatio: '1:1' });
    expect(aspectRatioScore(req, candidate({ aspectRatio: Math.SQRT2 }))).toBeCloseTo(0, 6);
  });

  it('16:9 与 9:16 的惩罚对称（用 log2 比值的理由）', () => {
    const req = requirement({ aspectRatio: '16:9' });
    const wide = aspectRatioScore(req, candidate({ aspectRatio: (16 / 9) * 1.2 }));
    const tall = aspectRatioScore(req, candidate({ aspectRatio: 16 / 9 / 1.2 }));
    expect(wide).toBeCloseTo(tall, 6);
  });

  it('超出半个八度记 0，不给负分', () => {
    const req = requirement({ aspectRatio: '16:9' });
    expect(aspectRatioScore(req, candidate({ aspectRatio: 9 / 16 }))).toBe(0);
  });

  it('素材缺比例 → 0.00', () => {
    expect(aspectRatioScore(requirement(), candidate({ aspectRatio: null }))).toBe(0);
  });
});

describe('resolution_score（权重 0.05）', () => {
  it.each([
    [799, 0],
    [800, 0.6],
    [1200, 0.8],
    [1600, 1],
    [3000, 1],
  ])('宽度 %i → %f', (width, expected) => {
    expect(resolutionScore(requirement(), candidate({ width }))).toBeCloseTo(expected, 6);
  });

  it('缺宽度 → 0（硬性不达标）', () => {
    expect(resolutionScore(requirement(), candidate({ width: null }))).toBe(0);
  });
});

describe('quality_score（权重 0.05）', () => {
  it('取列值', () => {
    expect(qualityScore(candidate({ qualityScore: 0.42 }))).toBe(0.42);
  });

  it('缺失取 0.5', () => {
    expect(qualityScore(candidate({ qualityScore: null }))).toBe(0.5);
  });
});

describe('license_score（权重 0.05）', () => {
  it.each([
    ['PLATFORM_OWNED' as const, false, 1],
    ['CC0' as const, false, 0.9],
    ['LICENSED' as const, false, 0.8],
    ['LICENSED' as const, true, 0.6],
    ['AI_GENERATED' as const, false, 0.7],
  ])('%s（需署名 %s）→ %f', (licenseType, attributionRequired, expected) => {
    expect(licenseScore(candidate({ licenseType, attributionRequired }))).toBe(expected);
  });
});

describe('final_score 加权求和', () => {
  it('七项权重之和为 1', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((acc, w) => acc + w, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('完美匹配 → 1.0', () => {
    const score = scoreAsset(
      requirement(),
      candidate({ cosine: 1, qualityScore: 1, width: 1600, aspectRatio: 16 / 9 }),
    );
    expect(score.final).toBeCloseTo(1, 6);
  });

  it('逐项相加与 final 一致（没有漏项或重复计权）', () => {
    const score = scoreAsset(requirement(), candidate());
    const manual =
      score.entity * SCORE_WEIGHTS.entity +
      score.destination * SCORE_WEIGHTS.destination +
      score.semantic * SCORE_WEIGHTS.semantic +
      score.aspectRatio * SCORE_WEIGHTS.aspectRatio +
      score.resolution * SCORE_WEIGHTS.resolution +
      score.quality * SCORE_WEIGHTS.quality +
      score.license * SCORE_WEIGHTS.license;
    expect(score.final).toBeCloseTo(manual, 6);
  });

  it('Hero 场景（无实体名）仍能达到 0.80 立即采用档', () => {
    /*
     * 这是 10.1 给中性值的目的：Hero 的实体项恒为 0.5（上限损失 0.175），
     * 其余项满分时 final = 0.825 —— 仍然在 0.80 之上。
     * 如果实体项记 0，上限只有 0.65，Hero 永远走不到素材库。
     */
    const score = scoreAsset(
      requirement({
        role: 'HERO_BACKGROUND',
        entityName: null,
        aspectRatio: '16:6',
        minWidth: 1600,
      }),
      candidate({
        entityName: null,
        cosine: 1,
        qualityScore: 1,
        width: 3200,
        aspectRatio: 16 / 6,
      }),
    );
    expect(score.final).toBeGreaterThanOrEqual(0.8);
  });

  it('同城但实体不符的素材达不到 0.65（不会被当成该景点的照片）', () => {
    const score = scoreAsset(
      requirement(),
      candidate({ entityName: '灵隐寺', cosine: 0.5, qualityScore: 1, width: 1600 }),
    );
    expect(score.final).toBeLessThan(0.65);
  });
});
