import { AI_IMAGE_TIMEOUT_MS } from '@tps/llm';
import { ASSET_LOCK_TTL_SECONDS } from '@tps/queue';
import { describe, expect, it } from 'vitest';

/**
 * 素材锁的 TTL 必须长于它保护的那次图片生成（R-82）。
 *
 * ## 为什么这个测试在这里
 *
 * `ASSET_LOCK_TTL_SECONDS` 在 `@tps/queue`，`AI_IMAGE_TIMEOUT_MS` 在 `@tps/llm`，
 * 两个包互不依赖（队列层不该知道模型超时，模型层不该知道锁）。
 * 这里是仓库里唯一能同时 import 到两边的地方 —— 与 `billing-limits.test.ts`
 * 守卫「估算参数 ≥ worker 真实上限」是同一个理由。
 *
 * ## 不满足的后果，以及它为什么难发现
 *
 * 锁短于生成耗时 → 一次耗时介于 TTL 与超时之间的生成会在完成前丢锁 →
 * 第二个任务拿到锁开始**重复生成同一张图**。后果有两个，且都不报错：
 *
 *   1. 双倍 AI 成本（`costUnits` 记的是发出的请求数，所以钱是真花了）；
 *   2. 后到者写 `assets` 时撞 `assets_cache_key_uk`，它上传的两个对象成为孤儿。
 *
 * 这正是 2026-08 之前的实际状态：TTL 是 30 秒而超时已被放宽到 40 秒，
 * 而锁的注释里还写着「比 AI 生成超时（20 秒）多 10 秒」—— 一个正确的论证
 * 因为它引用的数字被改了而变成了错的结论。
 *
 * ## 为什么断言的是「严格大于」而不是「大于等于」
 *
 * 相等意味着锁恰好在超时那一刻过期，而后处理（sharp 转 WebP + 缩略图）、
 * 两次上传和落库都发生在生成**之后**。相等等于把这些步骤的时间算成 0。
 */
describe('素材锁 TTL 与图片超时的关系', () => {
  it('TTL 严格长于单候选图片超时', () => {
    expect(ASSET_LOCK_TTL_SECONDS * 1_000).toBeGreaterThan(AI_IMAGE_TIMEOUT_MS);
  });

  it('留给后处理、上传与落库的余量不少于 10 秒', () => {
    /*
     * 余量的下限不是拍的：处理一张 1600×600 的 WebP 加缩略图在渲染镜像里
     * 约 1～2 秒，两次上传取决于网络，落库含一次 embedding 调用。
     * 10 秒是「这些步骤都慢一倍也还够」的量级。
     */
    const marginMs = ASSET_LOCK_TTL_SECONDS * 1_000 - AI_IMAGE_TIMEOUT_MS;
    expect(marginMs).toBeGreaterThanOrEqual(10_000);
  });

  it('TTL 不至于长到让崩溃后的接手无法忍受', () => {
    /*
     * 上界的理由与下界相反：持锁进程崩溃后，等待方只能靠 TTL 过期才能接手。
     * 120 秒已经超过 T2 目标（155 秒）的一半 —— 再长就意味着一次崩溃能让
     * 那个槽位在整个任务窗口内都拿不到图。
     */
    expect(ASSET_LOCK_TTL_SECONDS).toBeLessThanOrEqual(120);
  });
});
