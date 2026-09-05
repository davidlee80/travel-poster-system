import type { ImageClient, ImageRequest, ImageResult } from '@tps/llm';
import type { AssetRole } from '@tps/schemas';

/**
 * Fake AI 生成实现。
 *
 * 用于测试：模拟 AI 生成的命中/延迟/超时/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **按角色编排**：`byRole` 允许为 Hero / 景点 / 美食分别配置不同的行为；
 * - **延迟模拟**：`delayMs` 模拟 AI 生成耗时（真实场景下 Hero 生成可能需要 10～40 秒）；
 * - **故障模拟**：`error` 模拟生成超时或服务不可用；
 * - **命中模拟**：`bytes` 返回预置的图片字节。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`packages/llm/src/image.ts`）会：
 * 1. 调用 AI 图片生成 API（如 DALL-E、Midjourney）；
 * 2. 等待生成完成（可能需要几十秒）；
 * 3. 返回生成的图片字节。
 *
 * Fake 实现**不执行**这些操作，只返回预置的字节或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖外部 API，不依赖网络，不依赖 AI 服务的可用性。
 */
export interface FakeAiBehavior {
  /** 成功：返回图片字节 */
  readonly bytes?: Uint8Array;
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障：'timeout' | 'unavailable' */
  readonly error?: 'timeout' | 'unavailable';
}

export interface FakeAiGeneratorOptions {
  /** 按槽位角色编排行为 */
  readonly byRole?: Partial<Record<AssetRole, FakeAiBehavior>>;
  /** 全局默认行为 */
  readonly default?: FakeAiBehavior;
}

/**
 * 包装 `ImageClient`，按角色注入编排行为。
 */
export function wrapAiGenerator(
  client: ImageClient,
  options: FakeAiGeneratorOptions,
): ImageClient {
  const behaviorFor = (role: AssetRole): FakeAiBehavior => {
    return options.byRole?.[role] ?? options.default ?? {};
  };

  return {
    ...client,
    generate: async (request: ImageRequest): Promise<ImageResult> => {
      const role = inferRoleFromRequest(request);
      const behavior = behaviorFor(role);

      if (behavior.error === 'timeout') {
        throw new Error('FakeAiGenerator: 生成超时（编排）');
      }

      if (behavior.error === 'unavailable') {
        throw new Error('FakeAiGenerator: 服务不可用（编排）');
      }

      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      if (behavior.bytes !== undefined) {
        return {
          bytes: behavior.bytes,
          model: client.model,
          modelVersion: 'fake',
          seed: request.seed,
          costUnits: 0,
        };
      }

      // 默认：调用真实实现
      return client.generate(request);
    },
  };
}

/**
 * 判定一次生成请求对应的槽位角色。
 *
 * 生产路径经 `ai-generator.ts`（与 14.3 的 `generate-asset.ts`）发起，
 * 请求里带着 `role`（精确）。直接单测本 wrapper 时可以不带，此时按
 * 请求尺寸判定：三类槽位的请求比例互不相同（16:6 Hero / 16:9 景点 /
 * 4:3 美食，由 `imageSizeFor` 按槽位约束算出），高度对齐 8 的倍数会让
 * 实际比例略偏离名义比例，因此取最近者而不是精确相等。
 *
 * 曾经按提示词里的关键词猜：提示词是 `renderPrompt` 渲染的英文文本，
 * Hero 不含 "hero"、美食不含 "美食"，所有请求都会静默落进默认的
 * DESTINATION_PHOTO 分支 —— 按角色编排的 AI 行为因此从未真正生效过。
 */
function inferRoleFromRequest(request: ImageRequest): AssetRole {
  if (request.role !== undefined) return request.role;

  const ratio = request.width / request.height;
  const targets: readonly (readonly [AssetRole, number])[] = [
    ['HERO_BACKGROUND', 16 / 6],
    ['FOOD_IMAGE', 4 / 3],
    ['DESTINATION_PHOTO', 16 / 9],
  ];

  let best: AssetRole = 'DESTINATION_PHOTO';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [role, target] of targets) {
    const distance = Math.abs(ratio - target);
    if (distance < bestDistance) {
      best = role;
      bestDistance = distance;
    }
  }
  return best;
}

export { inferRoleFromRequest as _inferRoleFromRequestForTest };
