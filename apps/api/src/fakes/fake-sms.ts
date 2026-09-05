import type { SmsSender } from '../identity/phone-verification.js';

/**
 * Fake 短信发送实现。
 *
 * 用于测试：模拟短信发送的延迟/故障，验证降级链的正确性。
 *
 * ## 设计要点
 *
 * - **延迟模拟**：`sendDelayMs` 模拟发送慢；
 * - **故障模拟**：`sendError` 模拟发送失败。
 *
 * ## 与真实实现的差异
 *
 * 真实实现（`apps/api/src/identity/phone-verification.ts`）会：
 * 1. 调用短信供应商 API（如阿里云）；
 * 2. 等待发送完成。
 *
 * Fake 实现**不执行**这些操作，只记录发送事实或模拟延迟/故障。这保证了测试的确定性：
 * 不依赖短信供应商，不依赖网络。
 */
export interface FakeSmsBehavior {
  /** 发送延迟毫秒数 */
  readonly sendDelayMs?: number;
  /** 发送故障 */
  readonly sendError?: Error;
}

/**
 * 包装 `SmsSender`，注入编排行为。
 */
export function wrapSms(sender: SmsSender, behavior: FakeSmsBehavior): SmsSender {
  return {
    ...sender,
    sendCode: async (phoneE164, code) => {
      if (behavior.sendError) {
        throw behavior.sendError;
      }

      if (behavior.sendDelayMs !== undefined && behavior.sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.sendDelayMs));
      }

      return sender.sendCode(phoneE164, code);
    },
  };
}
