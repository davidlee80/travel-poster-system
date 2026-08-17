import { describe, expect, it } from 'vitest';
import { CANDIDATE_LIMIT, SELECTION_BUDGET_MS, selectBestCandidate } from './selection.js';
import type { ScoringCandidate, ScoringRequirement } from './scoring.js';

/**
 * 10.2 的检索终止条件（TP-3-08）。
 */

const requirement: ScoringRequirement = {
  role: 'DESTINATION_PHOTO',
  entityName: '拱宸桥',
  entityPlaceId: 'hz-gongchen-bridge',
  destinationName: '杭州',
  destinationPlaceId: 'cn-hangzhou',
  aspectRatio: '16:9',
  minWidth: 800,
};

/** 按目标分数构造候选：实体与目的地满分时 final 由 cosine 与质量决定 */
function candidate(overrides: Partial<ScoringCandidate> = {}): ScoringCandidate {
  return {
    assetId: 'asset-1',
    entityName: '拱宸桥',
    destinationName: '杭州',
    destinationPlaceId: 'cn-hangzhou',
    width: 1600,
    aspectRatio: 16 / 9,
    qualityScore: 1,
    licenseType: 'PLATFORM_OWNED',
    attributionRequired: false,
    cosine: 1,
    ...overrides,
  };
}

/** 分数明显不足的候选（实体不符） */
function weak(id: string): ScoringCandidate {
  return candidate({ assetId: id, entityName: '灵隐寺', cosine: 0, qualityScore: 0.2, width: 800 });
}

/**
 * 落在 0.65～0.79 之间的候选 —— 10.2 说的「可用，但优先继续查找」。
 *
 * 实体只是子串（0.85）、比例偏差、分辨率与质量偏低，因此进不了立即采用档。
 * 分数随 `cosine` 单调上升，用它控制候选之间的排序。
 */
function mediocre(id: string, cosine: number): ScoringCandidate {
  return candidate({
    assetId: id,
    entityName: '拱宸桥历史街区',
    cosine,
    qualityScore: 0.5,
    width: 900,
    aspectRatio: (16 / 9) * 1.3,
  });
}

describe('终止规则', () => {
  it('出现 >= 0.80 立即采用，不再算后面的候选', () => {
    const result = selectBestCandidate(requirement, [
      candidate({ assetId: 'high' }),
      weak('w1'),
      weak('w2'),
    ]);

    expect(result.outcome.kind).toBe('accepted');
    expect(result.outcome.best?.candidate.assetId).toBe('high');
    expect(result.outcome.reason).toBe('immediate');
    // 只算了第一个 —— 这就是「立即采用，停止」
    expect(result.evaluated).toBe(1);
  });

  it('无人达到 0.80 时算完全部候选并取最高分', () => {
    const mid = mediocre('mid', 0);
    const better = mediocre('better', 0.5);

    const result = selectBestCandidate(requirement, [mid, better]);
    expect(result.evaluated).toBe(2);
    expect(result.outcome.reason).toBe('exhausted');
    expect(result.outcome.best?.candidate.assetId).toBe('better');
    expect(result.outcome.best!.score.final).toBeLessThan(0.8);
    expect(result.outcome.kind).toBe('accepted');
  });

  it('最高分 < 0.65 → 不采用，进入下一层来源', () => {
    const result = selectBestCandidate(requirement, [weak('w1'), weak('w2')]);

    expect(result.outcome.kind).toBe('below_threshold');
    // 仍然把最好的那个带回去 —— 打点需要知道「差多少」
    expect(result.outcome.best).not.toBeNull();
    expect(result.outcome.best!.score.final).toBeLessThan(0.65);
  });

  it('没有候选 → below_threshold + empty', () => {
    const result = selectBestCandidate(requirement, []);
    expect(result.outcome.kind).toBe('below_threshold');
    expect(result.outcome.best).toBeNull();
    expect(result.outcome.reason).toBe('empty');
    expect(result.evaluated).toBe(0);
  });

  it('候选集截到 30 个（10.2 第 1 步的上界）', () => {
    const many = Array.from({ length: 100 }, (_v, i) => weak(`w${i}`));
    const result = selectBestCandidate(requirement, many);

    expect(CANDIDATE_LIMIT).toBe(30);
    expect(result.evaluated).toBe(30);
  });
});

describe('800 毫秒上限', () => {
  it('超时后停止打分并按已算出的最好结果处理', () => {
    /*
     * 假时钟：每次读时钟前进 100 毫秒，因此第 9 次检查时已到 800。
     * 用假时钟而不是真等待 —— 真等 800 毫秒的测试会让整个套件变慢，
     * 而且在 CI 上会因为负载抖动而偶发失败。
     */
    let clock = 0;
    const now = (): number => {
      clock += 100;
      return clock;
    };

    const many = Array.from({ length: 30 }, (_v, i) => weak(`w${i}`));
    const result = selectBestCandidate(requirement, many, { now, deadline: SELECTION_BUDGET_MS });

    expect(result.outcome.reason).toBe('timeout');
    expect(result.evaluated).toBeLessThan(30);
    expect(result.outcome.kind).toBe('below_threshold');
  });

  it('超时但已有达标候选时仍然采用（已算出的分数是真实的）', () => {
    let clock = 0;
    const now = (): number => {
      clock += 300;
      return clock;
    };

    // 第一个候选达 0.65 但不到 0.80；随后时钟就超预算了
    const decent = mediocre('decent', 0.5);
    const result = selectBestCandidate(requirement, [decent, weak('w1'), weak('w2'), weak('w3')], {
      now,
      deadline: SELECTION_BUDGET_MS,
    });

    expect(result.outcome.reason).toBe('timeout');
    expect(result.outcome.kind).toBe('accepted');
    expect(result.outcome.best?.candidate.assetId).toBe('decent');
  });

  it('预算检查在打分之前 —— 已超时则一个候选都不算', () => {
    const result = selectBestCandidate(requirement, [candidate()], {
      now: () => 1_000,
      deadline: 800,
    });

    expect(result.evaluated).toBe(0);
    expect(result.outcome.reason).toBe('timeout');
  });
});
