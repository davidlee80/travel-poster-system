import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  'FEATURE_ANONYMOUS_ENABLED',
] as const;

/*
 * **前后各清一次**，而不是只在 afterEach 清。
 *
 * 只清 afterEach 的话，第一条用例会被**外部环境**污染 ——
 * `FEATURE_ANONYMOUS_ENABLED=true pnpm test` 会让「缺省全开」那条红，
 * 而红的原因与代码无关。这是 P7 回切验证时真实撞到的：
 * 把开关打开跑一遍回归，唯一失败的就是这条断言默认值的用例。
 *
 * 断言默认值的测试必须自己保证环境干净 —— 它验的恰恰是「什么都没配时」。
 */
beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

const ALL_ON: FeatureFlags = {
  generationEnabled: true,
  exportEnabled: true,
  generationRolloutPercent: 100,
  // P7：匿名入口的默认值与其余三项相反，见下方用例
  anonymousEnabled: false,
};

describe('loadFeatureFlags', () => {
  it('缺省全开、放量 100%（匿名入口除外）', () => {
    /*
     * 默认全开而不是全关：忘记配开关的表现应当是「与引入灰度之前一样」，
     * 而不是「整个产品 503」—— 后者那种故障在灰度机制引入前不存在，
     * 排查时没人会想到去看开关。
     */
    expect(loadFeatureFlags()).toEqual(ALL_ON);
  });

  it('匿名入口默认**关闭**，与其余三项的默认方向相反（P7）', () => {
    /*
     * 这一条是刻意的不对称，值得一条专门的用例钉住。
     *
     * 其余三个开关是「正常开着，紧急时关」——「忘记配」应当等于「和引入
     * 灰度之前一样」。而匿名入口是**产品已经决定关闭**的功能：忘记配它
     * 不该等于「回到旧行为」，那会让任何漏配的部署静默重新开放匿名注册，
     * 而那是一次产品行为的回退，不是一次可观测的故障 ——
     * 没有任何告警会响，只有转化数据在几周后变得可疑。
     */
    expect(loadFeatureFlags().anonymousEnabled).toBe(false);
  });

  it('匿名入口可以显式打开（重新开放旧行为的唯一途径）', () => {
    process.env['FEATURE_ANONYMOUS_ENABLED'] = 'true';
    expect(loadFeatureFlags().anonymousEnabled).toBe(true);
  });

  it('匿名入口的取值解析与其余布尔开关一致（含 1/yes，非法值抛错）', () => {
    /*
     * 复用 `optionalBool` 而不是自己解析：三个开关的取值语义必须一致 ——
     * 「`FEATURE_EXPORT_ENABLED=1` 有效但 `FEATURE_ANONYMOUS_ENABLED=1`
     * 被当成 false」是一种没人能预料的不一致，而它的表现是静默开放匿名。
     *
     * 非法值抛错这一条尤其重要：如果 `yes ` （带空格）被吞成默认值 false，
     * 那么想**打开**匿名的人会得到「配了但没生效」而没有任何提示。
     */
    process.env['FEATURE_ANONYMOUS_ENABLED'] = 'false';
    expect(loadFeatureFlags().anonymousEnabled).toBe(false);

    process.env['FEATURE_ANONYMOUS_ENABLED'] = '1';
    expect(loadFeatureFlags().anonymousEnabled).toBe(true);

    process.env['FEATURE_ANONYMOUS_ENABLED'] = 'yes';
    expect(loadFeatureFlags().anonymousEnabled).toBe(true);

    process.env['FEATURE_ANONYMOUS_ENABLED'] = 'maybe';
    expect(() => loadFeatureFlags()).toThrow(/必须是布尔值/);
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
      anonymousEnabled: false,
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
