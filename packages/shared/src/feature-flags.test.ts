import { afterEach, describe, expect, it } from 'vitest';

import {
  bucketOf,
  decideFeature,
  isInRollout,
  loadFeatureFlags,
  type FeatureFlags,
} from './feature-flags.js';

/** 灰度开关与百分比放量（TP-5-10） */

const KEYS = [
  'FEATURE_GENERATION_ENABLED',
  'FEATURE_EXPORT_ENABLED',
  'FEATURE_GENERATION_ROLLOUT_PERCENT',
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

const ALL_ON: FeatureFlags = {
  generationEnabled: true,
  exportEnabled: true,
  generationRolloutPercent: 100,
};

describe('loadFeatureFlags', () => {
  it('缺省全开、放量 100%', () => {
    /*
     * 默认全开而不是全关：忘记配开关的表现应当是「与引入灰度之前一样」，
     * 而不是「整个产品 503」—— 后者那种故障在灰度机制引入前不存在，
     * 排查时没人会想到去看开关。
     */
    expect(loadFeatureFlags()).toEqual(ALL_ON);
  });

  it('放量比例越界时拒绝启动', () => {
    /*
     * 不钳到 [0,100]。钳的话，把 1000 误当千分比写进 values 的人会得到
     * 「全量放量」而他以为配的是 0.1% —— 那是一次静默的全量上线。
     * 而 -1 会被钳成 0，表现是「新功能一个用户都没有」，同样静默。
     */
    process.env['FEATURE_GENERATION_ROLLOUT_PERCENT'] = '1000';
    expect(() => loadFeatureFlags()).toThrow(/0～100/);

    process.env['FEATURE_GENERATION_ROLLOUT_PERCENT'] = '-1';
    expect(() => loadFeatureFlags()).toThrow(/0～100/);
  });

  it('读得到关闭状态', () => {
    process.env['FEATURE_GENERATION_ENABLED'] = 'false';
    process.env['FEATURE_EXPORT_ENABLED'] = 'false';
    process.env['FEATURE_GENERATION_ROLLOUT_PERCENT'] = '30';

    expect(loadFeatureFlags()).toEqual({
      generationEnabled: false,
      exportEnabled: false,
      generationRolloutPercent: 30,
    });
  });
});

describe('isInRollout', () => {
  it('同一个用户的判定是稳定的', () => {
    /*
     * 这是整套机制的核心。用随机数的话，同一个用户刷新页面就会在「能用」与
     * 「维护中」之间来回跳 —— 而他会以为是自己网络的问题，
     * 或者反复重试直到撞上那 30%。
     */
    const userId = '3f2b9c40-0000-4000-8000-000000000000';
    const first = isInRollout(userId, 37);
    for (let i = 0; i < 50; i += 1) {
      expect(isInRollout(userId, 37)).toBe(first);
    }
  });

  it('放量比例提高时，原来命中的用户仍然命中', () => {
    /*
     * 单调性。分桶号不随比例变化，因此 30% → 50% 只会**新增**用户。
     * 反过来（每次放量重新洗牌）会让一部分用户在放量扩大时反而失去访问 ——
     * 那是灰度里最难解释的一类工单。
     */
    const users = Array.from({ length: 200 }, (_, i) => `user-${i}`);
    const at30 = users.filter((user) => isInRollout(user, 30));
    const at50 = users.filter((user) => isInRollout(user, 50));

    for (const user of at30) {
      expect(at50, `${user} 在 30% 时命中，50% 时也应命中`).toContain(user);
    }
    expect(at50.length).toBeGreaterThanOrEqual(at30.length);
  });

  it('两个边界不走哈希', () => {
    // 「全量」与「全关」不该依赖哈希分布是否均匀
    expect(isInRollout('any', 100)).toBe(true);
    expect(isInRollout('any', 0)).toBe(false);
  });

  it('分桶大致均匀（1000 个用户在 30% 下落在 ±8% 内）', () => {
    /*
     * 倾斜的表现是「放量 10% 实际影响了 40% 的用户」，而那只有事后看指标
     * 才发现。用 sha256 而不是廉价散列正是为此：user_id 是 UUID，
     * 长度恒定、字符集有限，简单散列会严重倾斜。
     *
     * ±8% 的容差对 1000 个样本是宽松的（二项分布的标准差约 1.4%），
     * 留出余量是为了让这条断言不因为换了 ID 生成方式就变红。
     */
    const users = Array.from({ length: 1000 }, (_, i) => `uuid-like-${i}-0000-4000-8000`);
    const hit = users.filter((user) => isInRollout(user, 30)).length;
    expect(hit).toBeGreaterThan(220);
    expect(hit).toBeLessThan(380);
  });

  it('分桶号在 0～99 之间', () => {
    for (let i = 0; i < 100; i += 1) {
      const bucket = bucketOf(`user-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });
});

describe('decideFeature', () => {
  it('全开时放行', () => {
    expect(decideFeature(ALL_ON, 'generation', 'u1')).toEqual({ allowed: true });
    expect(decideFeature(ALL_ON, 'export', 'u1')).toEqual({ allowed: true });
  });

  it('关闭与未命中放量是两种不同的拒绝原因', () => {
    /*
     * 「功能被关了」是全局状态（该修或该开），「你不在这批放量里」是预期行为。
     * 合成一个的话，放量期间的正常拒绝会和一次误操作关闭混在同一条曲线上 ——
     * 而那条曲线是放量期间唯一能看的东西。
     */
    expect(decideFeature({ ...ALL_ON, generationEnabled: false }, 'generation', 'u1')).toEqual({
      allowed: false,
      reason: 'disabled',
    });
    expect(decideFeature({ ...ALL_ON, generationRolloutPercent: 0 }, 'generation', 'u1')).toEqual({
      allowed: false,
      reason: 'not_in_rollout',
    });
  });

  it('导出只有开/关，没有百分比放量', () => {
    /*
     * 导出没有新旧两套实现可以对比，开关的用途只是紧急止血。
     * 因此放量比例为 0 时导出仍然放行 —— 那个比例只管生成。
     */
    expect(decideFeature({ ...ALL_ON, generationRolloutPercent: 0 }, 'export', 'u1')).toEqual({
      allowed: true,
    });
  });

  it('关掉生成不影响导出（成本量级差三个数量级）', () => {
    /*
     * 21.4：生成要花模型调用的钱，导出只花几秒 Chromium CPU。
     * 紧急降成本时先关生成、保留导出 —— 用户至少还能把已有的计划导出带走。
     */
    const flags: FeatureFlags = { ...ALL_ON, generationEnabled: false };
    expect(decideFeature(flags, 'generation', 'u1').allowed).toBe(false);
    expect(decideFeature(flags, 'export', 'u1').allowed).toBe(true);
  });
});
