import { InMemoryPlanQueue } from '@tps/queue';
import { makeValidRequest } from '@tps/planning';
import {
  GracefulShutdown,
  InMemoryCounterStore,
  InMemoryIdempotencyLock,
  QuotaGuard,
  createSilentLogger,
  type QuotaConfig,
  type ServiceConfig,
} from '@tps/shared';
import type {
  PlannerConfigRepository,
  PresentationsRepository,
  PublishedPlannerConfig,
  TravelPlansRepository,
} from '@tps/db';
import { describe, expect, it } from 'vitest';

import { FakeUsersRepository } from '../identity/fake-users-repository.js';
import { InMemorySessionStore } from '../identity/session-store.js';
import { IdentityService } from '../identity/service.js';
import { buildServer } from '../server.js';

import { isConditionCodeOption } from './travel-plans.js';

/**
 * 条件码白名单在**装了配置中心**时的行为。
 *
 * ## 为什么单独一个文件而不是并进 travel-plans.test.ts
 *
 * 那份夹具的 `build()` 被 174 个用例共用，且刻意**不装** `plannerConfig`——
 * 「没有配置中心」是本地开发与绝大多数用例的语境。给它加一个可选参数会让
 * 每个读那份夹具的人都要先判断「这一路有没有配置」。
 *
 * ## 这些用例盯的是什么
 *
 * `conflicts.ts` 那一行是
 * `allowedConditionCodes?.has(code) ?? isKnownConditionCode(code)`，是 `??`
 * 而不是并集 —— 一旦库里有已发布配置，内置字典完全不参与判断。于是
 * 「白名单怎么算出来的」直接决定哪些请求能过，而算错的表现是界面完全正常
 * 却提交被拒。用例逐条对应：停用真的生效、投影码不因为界面没有标签而被漏掉、
 * 配置新增的码能过、标成 ENUM 的界面选项不混进白名单、
 * 以及未标注 `value_kind` 的旧行回退到旧后缀约定。
 */

const config: ServiceConfig = {
  serviceName: 'tps-api-test',
  port: 0,
  nodeEnv: 'test',
  logLevel: 'silent',
  shutdownTimeoutMs: 1_000,
};

const quotaConfig: QuotaConfig = {
  anonymous: { perMinute: 50, dailyPlans: 50, monthlyPlans: 50, exportsPerPlan: 3, aiHero: 0 },
  registered: { perMinute: 50, dailyPlans: 50, monthlyPlans: 50, exportsPerPlan: 10, aiHero: 2 },
  ip: { anonCreatePerHour: 500, anonCreatePerDay: 500, plansPerDay: 500, loginFailuresPerHour: 10 },
  emailLoginFailuresPerHour: 5,
  anonTokenTtlDays: 30,
};

const now = () => new Date('2026-03-01T00:00:00.000Z');

/**
 * 只够 `generate` 走通的假仓储。
 *
 * 其余方法一律抛而不是返回空数据：这个文件里没有任何用例会走到它们，
 * 而一个「返回 null」的桩会让将来某个用例意外走进来时看起来一切正常
 * —— 抛出来则会立刻指出「这个文件的夹具不覆盖那条路径」。
 */
function unused(name: string): never {
  throw new Error(`本文件的假仓储不实现 ${name}`);
}

class MinimalPlansRepository implements TravelPlansRepository {
  private sequence = 0;

  createGeneration(): Promise<{ requestId: string; planId: string; jobId: string }> {
    this.sequence += 1;
    return Promise.resolve({
      requestId: `request-${this.sequence}`,
      planId: `plan-${this.sequence}`,
      jobId: `job-${this.sequence}`,
    });
  }

  findByIdempotencyKey(): Promise<null> {
    return Promise.resolve(null);
  }

  findPlanForUser = () => unused('findPlanForUser');
  findJobForUser = () => unused('findJobForUser');
  listPlansForUser = () => unused('listPlansForUser');
  findJobContext = () => unused('findJobContext');
  updateJobState = () => unused('updateJobState');
  markMilestone = () => unused('markMilestone');
  cancelJob = () => unused('cancelJob');
  appendJobWarnings = () => unused('appendJobWarnings');
  findJobQueueTiming = () => unused('findJobQueueTiming');
  savePlanVersion = () => unused('savePlanVersion');
}

class MinimalPresentationsRepository implements PresentationsRepository {
  savePresentations = () => unused('savePresentations');
  findPresentation = () => unused('findPresentation');
  findPresentationByVersion = () => unused('findPresentationByVersion');
  listDayNumbers = () => unused('listDayNumbers');
  saveBindings = () => unused('saveBindings');
  listBindings = () => unused('listBindings');
}

/** 只有 `getPublished` 的假仓储 —— 端点用到的就是这一个方法 */
function fakeConfig(fields: PublishedPlannerConfig['fields']): PlannerConfigRepository {
  return {
    getPublished: () =>
      Promise.resolve({ version: 3, publishedAt: now().toISOString(), fields }),
  };
}

/** 按 0012 的形态给一组码，`value_kind` 显式标注 */
function codes(fieldKey: string, keys: readonly string[]): PublishedPlannerConfig['fields'] {
  return {
    [fieldKey]: keys.map((key) => ({
      key,
      label: key,
      metadata: { value_kind: 'CONDITION_CODE' },
    })),
  };
}

function build(fields: PublishedPlannerConfig['fields']) {
  const users = new FakeUsersRepository(now);
  const quota = new QuotaGuard({ config: quotaConfig, store: new InMemoryCounterStore(), now });
  const identity = new IdentityService({
    users,
    sessions: new InMemorySessionStore(),
    quota,
    quotaConfig,
    now,
    secureCookies: false,
    anonymousEnabled: true,
  });

  return buildServer({
    config,
    logger: createSilentLogger(),
    shutdown: new GracefulShutdown({ logger: createSilentLogger(), timeoutMs: 1_000 }),
    auth: { identity, quota, secureCookies: false },
    travelPlans: {
      identity,
      quota,
      queue: new InMemoryPlanQueue(),
      plans: new MinimalPlansRepository(),
      presentations: new MinimalPresentationsRepository(),
      idempotencyLock: new InMemoryIdempotencyLock(),
      plannerConfig: fakeConfig(fields),
      secureCookies: false,
      now,
    },
  });
}

async function submit(
  fields: PublishedPlannerConfig['fields'],
  conditions: readonly { code: string; mode: 'MUST' | 'SHOULD'; value: boolean }[],
): Promise<{ status: number; body: string }> {
  /*
   * `conditions` 在夹具的重载类型里是 `ConditionCode[]`（内置字典的字面量联合），
   * 而这里有两个用例**故意**发内置字典里没有的码 —— 那正是被测的行为。
   * 因此在夹具之外覆盖这一项，而不是给夹具放宽类型：放宽会让其余 174 个用例
   * 也失去「码写错了是编译错误」这个保护。
   */
  const payload: Record<string, unknown> = { ...makeValidRequest(), conditions };

  const app = build(fields);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/travel-plans/generate',
      payload,
    });
    return { status: response.statusCode, body: response.body };
  } finally {
    await app.close();
  }
}

describe('已发布配置决定条件码白名单', () => {
  it('配置里有的码通过', async () => {
    const result = await submit(codes('interests.tags', ['interest.food']), [
      { code: 'interest.food', mode: 'SHOULD', value: true },
    ]);
    expect(result.status).toBe(201);
  });

  it('配置里停用掉的码被 N-08 拒 —— 这才是「删除」真的生效', async () => {
    /*
     * 内置字典里 `interest.nightlife` 是合法码，因此这一条同时证明
     * 「已发布配置替换内置字典」这个语义仍然成立。
     */
    const result = await submit(codes('interests.tags', ['interest.food']), [
      { code: 'interest.nightlife', mode: 'SHOULD', value: true },
    ]);
    /* 400 是 `error-codes.ts` 给 REQ_CONDITION_CODE_UNKNOWN 定的状态码 */
    expect(result.status).toBe(400);
    expect(result.body).toContain('REQ_CONDITION_CODE_UNKNOWN');
  });

  it('投影专用的码照样通过 —— 它们界面上没有标签', async () => {
    /*
     * 这条是判据从「field_key 以 tags 结尾」改成 `metadata.value_kind` 的理由：
     * `diet.vegetarian` 由前端从「饮食要求」这个枚举答案投影出来，
     * 挂在 `conditions.projected` 下 —— 那个 field_key 不以 tags 结尾，
     * 旧判据会把它整组漏掉，而用户根本不知道自己「选过」这个码。
     */
    const result = await submit(codes('conditions.projected', ['diet.vegetarian']), [
      { code: 'diet.vegetarian', mode: 'MUST', value: true },
    ]);
    expect(result.status).toBe(201);
  });

  it('配置新发布的码通过，即使内置字典里没有', async () => {
    /*
     * 契约里 `code` 是域前缀正则，因此新码能过 schema；白名单来自配置，
     * 因此也能过 N-08。它仍需进 `conditions.ts` 才能进 Prompt 的分域遍历 ——
     * 那一步由 planner-config-coverage.test.ts 盯着。
     */
    const result = await submit(codes('lodging.amenities', ['accommodation.rooftop_bar']), [
      { code: 'accommodation.rooftop_bar', mode: 'SHOULD', value: true },
    ]);
    expect(result.status).toBe(201);
  });

  it('标成 ENUM 的行不进白名单', async () => {
    /*
     * 界面选项与条件码字典是两件事。把 `trip.destination_status` 的
     * `CONFIRMED` 当成条件码会让白名单里混进一堆枚举成员，
     * 而那意味着一个拼错的条件码可能因为撞上某个枚举值而通过 N-08。
     */
    const result = await submit(
      {
        'trip.destination_status': [
          { key: 'CONFIRMED', label: '已经确定', metadata: { value_kind: 'ENUM' } },
        ],
      },
      [{ code: 'interest.food', mode: 'SHOULD', value: true }],
    );
    /* 400 是 `error-codes.ts` 给 REQ_CONDITION_CODE_UNKNOWN 定的状态码 */
    expect(result.status).toBe(400);
    expect(result.body).toContain('REQ_CONDITION_CODE_UNKNOWN');
  });
});

describe('未标注 value_kind 的行回退到旧后缀约定', () => {
  /*
   * 0010 / 0011 插入的行没有 `value_kind`。迁移是前向的，而 API 与数据库的
   * 部署不是原子的 —— 「新 API 已上线、库还停在 0011」这个中间态如果让白名单
   * 变成空集，那一段时间里所有带条件码的请求都会被拒。
   */
  it('以 tags 结尾的旧 field_key 仍然算条件码', () => {
    expect(isConditionCodeOption('transport.mode_tags', {})).toBe(true);
    expect(isConditionCodeOption('interest.tags', {})).toBe(true);
  });

  it('不以 tags 结尾的旧 field_key 不算 —— 与 0011 之前的行为一致', () => {
    expect(isConditionCodeOption('budget.tiers', {})).toBe(false);
  });

  it('显式标注一律优先于后缀', () => {
    /* 新口径下 `lodging.amenities` 装的正是条件码，而它不以 tags 结尾 */
    expect(isConditionCodeOption('lodging.amenities', { value_kind: 'CONDITION_CODE' })).toBe(true);
    /* 反过来：标了 ENUM 的 `*_tags` 不再被后缀带进白名单 */
    expect(isConditionCodeOption('legacy.mode_tags', { value_kind: 'ENUM' })).toBe(false);
  });
});
