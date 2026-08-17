import { aspectRatioValue, type AssetRole, type AspectRatio, type LicenseType } from '@tps/schemas';
import { jaccard, normalizeName, tokenize } from './normalize.js';

/**
 * 素材匹配评分（TP-3-07，设计稿十章、10.1）。
 *
 * 七个子函数全部返回 `[0, 1]`，加权求和为 `final_score`。
 * 全部是**纯函数**：不查库、不调嵌入模型。语义相似度所需的余弦值由调用方
 * 传入（向量检索本来就要算距离，再算一次是白花一次嵌入调用，见 19.4）。
 */

export const SCORE_WEIGHTS = {
  entity: 0.35,
  destination: 0.2,
  semantic: 0.2,
  aspectRatio: 0.1,
  resolution: 0.05,
  quality: 0.05,
  license: 0.05,
} as const;

/** 十章的阈值：≥ 0.80 直接用；0.65～0.79 可用；< 0.65 进下一层 */
export const SCORE_ACCEPT_IMMEDIATELY = 0.8;
export const SCORE_MINIMUM = 0.65;

/** 10.1：`entity_name` 缺省时该项按中性值计入，避免 Hero 永远走不到素材库 */
export const NEUTRAL_ENTITY_SCORE = 0.5;
/** 10.1：`quality_score` 缺失时取 0.5 */
export const NEUTRAL_QUALITY_SCORE = 0.5;

/**
 * 别名表（10.1 举的例子就是这一条）。
 *
 * 只收「同一实体的不同官方/俗称写法」，不收近似实体 ——
 * 别名命中给 0.90，与「完全相等」几乎同级，收错一条的后果是
 * 把另一个地点的照片当成本地点的展示图。
 */
export const ENTITY_ALIASES: readonly (readonly string[])[] = [
  ['中国大运河博物馆', '大运河博物馆', '运河博物馆'],
  ['中国丝绸博物馆', '丝绸博物馆'],
  ['杭州西湖', '西湖'],
  ['灵隐寺', '灵隐禅寺'],
  ['京杭大运河', '大运河'],
  ['拱宸桥历史街区', '拱宸桥'],
];

const ALIAS_INDEX: ReadonlyMap<string, number> = new Map(
  ENTITY_ALIASES.flatMap((group, index) =>
    group.map((name) => [normalizeName(name), index] as const),
  ),
);

/** 10.1：`role` 中文名进语义检索的查询文本 */
export const ROLE_QUERY_LABEL: Record<AssetRole, string> = {
  HERO_BACKGROUND: '主题氛围插画',
  FOOD_IMAGE: '美食图',
  DESTINATION_PHOTO: '景点照片',
  ROUTE_MAP: '路线示意图',
};

// ── 需求侧与素材侧的输入 ────────────────────────────────────

export interface ScoringRequirement {
  readonly role: AssetRole;
  readonly entityName: string | null;
  readonly entityPlaceId: string | null;
  readonly destinationName: string;
  readonly destinationPlaceId: string | null;
  readonly aspectRatio: AspectRatio;
  readonly minWidth: number;
}

export interface ScoringCandidate {
  readonly assetId: string;
  readonly entityName: string | null;
  readonly destinationName: string | null;
  readonly destinationPlaceId: string | null;
  readonly width: number | null;
  readonly aspectRatio: number | null;
  readonly qualityScore: number | null;
  readonly licenseType: LicenseType;
  readonly attributionRequired: boolean;
  /**
   * 与查询向量的**余弦值**（`[-1, 1]`），不是距离。
   *
   * pgvector 的 `<=>` 返回余弦距离，仓储层已换算为 `1 - distance`。
   * 为 null 表示该素材没有向量（未向量化），此时语义项按中性 0.5 计入 ——
   * 记 0 会让所有未向量化的素材永远达不到 0.65，等于把它们从库里删掉。
   */
  readonly cosine: number | null;
}

// ── 七个子函数 ──────────────────────────────────────────────

/**
 * 实体名称匹配（权重 0.35）。
 *
 * 四条规则**取最大值**而不是「先匹配先返回」：10.1 把它们列成一张表，
 * 而别名（0.90）排在子串（0.85）之后 —— 顺序判定会让
 * 「大运河博物馆」↔「中国大运河博物馆」这对（既是子串又是别名）得 0.85
 * 而不是 0.90。取最大值让规则之间无顺序依赖。
 */
export function entityMatch(requirement: ScoringRequirement, candidate: ScoringCandidate): number {
  if (requirement.entityName === null || requirement.entityName.length === 0) {
    return NEUTRAL_ENTITY_SCORE;
  }
  if (candidate.entityName === null || candidate.entityName.length === 0) return 0;

  const a = normalizeName(requirement.entityName);
  const b = normalizeName(candidate.entityName);
  if (a.length === 0 || b.length === 0) return 0;

  if (a === b) return 1;

  const scores: number[] = [0];

  const aliasA = ALIAS_INDEX.get(a);
  const aliasB = ALIAS_INDEX.get(b);
  if (aliasA !== undefined && aliasA === aliasB) scores.push(0.9);

  if (a.includes(b) || b.includes(a)) scores.push(0.85);

  if (jaccard(tokenize(a), tokenize(b)) >= 0.6) scores.push(0.7);

  return Math.max(...scores);
}

/**
 * 目的地匹配（权重 0.20）。
 *
 * 「同省/同都市圈」那一档需要行政区划表。V1 只内置了种子素材覆盖到的城市
 * （见 `CITY_REGION`），表外一律记 0 —— 这是保守方向：少给 0.10 分
 * （0.5 × 0.20）不会让不相关的素材被采用，而错给会。
 */
export function destinationMatch(
  requirement: ScoringRequirement,
  candidate: ScoringCandidate,
): number {
  if (
    requirement.destinationPlaceId !== null &&
    candidate.destinationPlaceId !== null &&
    requirement.destinationPlaceId === candidate.destinationPlaceId
  ) {
    return 1;
  }

  const a = normalizeName(requirement.destinationName);
  const b = candidate.destinationName === null ? '' : normalizeName(candidate.destinationName);
  if (a.length > 0 && a === b) return 0.95;

  const regionA = regionOf(requirement.destinationName, requirement.destinationPlaceId);
  const regionB = regionOf(candidate.destinationName, candidate.destinationPlaceId);
  if (regionA !== null && regionA === regionB) return 0.5;

  return 0;
}

/**
 * V1 的行政区划表（10.1「同省/同都市圈」）。
 *
 * 中文名与 `place_id` 里的拉丁写法都收 —— 需求侧带的是名称，
 * 素材侧可能只有 `place_id`（`cn-hangzhou`），两边都要能查到区域。
 *
 * 只覆盖 V1 种子素材涉及的城市。补全到 Top 50 属于素材数据工作（TP-3-06），
 * 不属于评分逻辑 —— 表外城市走 0 分档，方向保守：
 * 少给 0.1 分（0.5 × 0.20）不会让不相关素材被采用，错给会。
 */
export const REGION_CITIES: Readonly<Record<string, readonly string[]>> = {
  zhejiang: ['杭州', 'hangzhou', '绍兴', 'shaoxing', '宁波', 'ningbo', '嘉兴', 'jiaxing'],
  jiangsu: ['苏州', 'suzhou', '南京', 'nanjing', '无锡', 'wuxi', '扬州', 'yangzhou'],
  shanghai: ['上海', 'shanghai'],
  beijing: ['北京', 'beijing'],
  guangdong: ['广州', 'guangzhou', '深圳', 'shenzhen'],
  sichuan: ['成都', 'chengdu'],
  shaanxi: ['西安', 'xian'],
  fujian: ['厦门', 'xiamen'],
  yunnan: ['昆明', 'kunming', '大理', 'dali', '丽江', 'lijiang'],
  henan: ['洛阳', 'luoyang', '开封', 'kaifeng'],
};

const REGION_INDEX: ReadonlyMap<string, string> = new Map(
  Object.entries(REGION_CITIES).flatMap(([region, cities]) =>
    cities.map((city) => [normalizeName(city), region] as const),
  ),
);

function regionOf(name: string | null, placeId: string | null): string | null {
  if (name !== null) {
    const region = REGION_INDEX.get(normalizeName(name));
    if (region !== undefined) return region;
  }
  if (placeId !== null) {
    /*
     * `cn-hangzhou` 这类 place_id 按分段查表。不做前缀猜测 ——
     * place_id 的命名规则由数据源决定，猜错会把「另一个省的同名区」
     * 判成同省，而那一档有 0.1 分的实际影响。
     */
    for (const segment of placeId.toLowerCase().split(/[-_:/]/)) {
      const region = REGION_INDEX.get(segment);
      if (region !== undefined) return region;
    }
  }
  return null;
}

/**
 * 语义相似度（权重 0.20）。
 *
 * 10.1：`score = clamp((cosine + 1) / 2, 0, 1)`。
 * 线性映射而不是直接用余弦：余弦可以为负，直接用会让负相关素材
 * 与「没有向量」不可区分。
 */
export function semanticSimilarity(candidate: ScoringCandidate): number {
  if (candidate.cosine === null) return NEUTRAL_QUALITY_SCORE;
  return clamp((candidate.cosine + 1) / 2, 0, 1);
}

/** 10.1 的查询文本构造（供仓储层向量化查询用） */
export function semanticQueryText(input: {
  readonly role: AssetRole;
  readonly entityName?: string | null;
  readonly destination?: string | null;
  readonly styleTags?: readonly string[] | null;
}): string {
  return [
    input.entityName ?? '',
    input.destination ?? '',
    ROLE_QUERY_LABEL[input.role],
    (input.styleTags ?? []).join(' '),
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * 画面比例匹配（权重 0.10）。
 *
 * `d = |log2(r_asset / r_req)|`，`score = max(0, 1 - d / 0.5)`。
 * 用比值的对数而不是差值，保证 16:9 与 9:16 的惩罚对称 ——
 * 用差值时前者偏差 0.33、后者 1.22，同样是「转了 90 度」却差 4 倍。
 */
export function aspectRatioScore(
  requirement: ScoringRequirement,
  candidate: ScoringCandidate,
): number {
  if (candidate.aspectRatio === null || candidate.aspectRatio <= 0) return 0;

  const required = aspectRatioValue(requirement.aspectRatio);
  const d = Math.abs(Math.log2(candidate.aspectRatio / required));
  return Math.max(0, 1 - d / 0.5);
}

/** 分辨率评分（权重 0.05）。低于 `min_width` 是硬性不达标，记 0 */
export function resolutionScore(
  requirement: ScoringRequirement,
  candidate: ScoringCandidate,
): number {
  const width = candidate.width;
  const min = requirement.minWidth;
  if (width === null || width < min) return 0;
  if (width >= 2 * min) return 1;
  return 0.6 + (0.4 * (width - min)) / min;
}

/** 素材质量（权重 0.05）。入库时离线计算，检索路径直接取列值 */
export function qualityScore(candidate: ScoringCandidate): number {
  return candidate.qualityScore ?? NEUTRAL_QUALITY_SCORE;
}

/** 使用许可评分（权重 0.05，10.1 的表） */
export function licenseScore(candidate: ScoringCandidate): number {
  switch (candidate.licenseType) {
    case 'PLATFORM_OWNED':
      return 1;
    case 'CC0':
      return 0.9;
    case 'LICENSED':
      // 需署名的分更低：署名文案要占版面，且 PDF 导出后无法补
      return candidate.attributionRequired ? 0.6 : 0.8;
    case 'AI_GENERATED':
      return 0.7;
  }
}

// ── 加权求和 ────────────────────────────────────────────────

export interface ScoreBreakdown {
  readonly entity: number;
  readonly destination: number;
  readonly semantic: number;
  readonly aspectRatio: number;
  readonly resolution: number;
  readonly quality: number;
  readonly license: number;
  readonly final: number;
}

export function scoreAsset(
  requirement: ScoringRequirement,
  candidate: ScoringCandidate,
): ScoreBreakdown {
  const entity = entityMatch(requirement, candidate);
  const destination = destinationMatch(requirement, candidate);
  const semantic = semanticSimilarity(candidate);
  const aspect = aspectRatioScore(requirement, candidate);
  const resolution = resolutionScore(requirement, candidate);
  const quality = qualityScore(candidate);
  const license = licenseScore(candidate);

  const final =
    entity * SCORE_WEIGHTS.entity +
    destination * SCORE_WEIGHTS.destination +
    semantic * SCORE_WEIGHTS.semantic +
    aspect * SCORE_WEIGHTS.aspectRatio +
    resolution * SCORE_WEIGHTS.resolution +
    quality * SCORE_WEIGHTS.quality +
    license * SCORE_WEIGHTS.license;

  return {
    entity,
    destination,
    semantic,
    aspectRatio: aspect,
    resolution,
    quality,
    license,
    // 浮点误差会让权重和为 0.9999999999999999，进而让「恰好 0.65」的素材
    // 被拒。四舍五入到 6 位小数，远超阈值判定需要的精度
    final: Math.round(final * 1e6) / 1e6,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
