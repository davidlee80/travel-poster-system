import type { CreditWalletRepository } from '@tps/db';
import type { Logger } from '@tps/shared';

/**
 * 导出失败时退回那一笔 CR（C-4b）。
 *
 * 导出的扣费发生在 **API 收到请求时**（定价固定、与内容无关，因此不做
 * 预留/结算往返，见 docs/用户货币与计费.md 第五节）。而渲染可能在几秒后失败 ——
 * 那时用户没拿到任何文件，钱必须退。
 *
 * ## 退多少：回查那一笔，不现算
 *
 * `estimateExportCost(format, 当前价目)` 现算一遍更省事，但调价窗口内会退错数：
 * 少退是我们赖账，多退是可以被反复触发的漏洞。因此按 `ref_type/ref_id`
 * 回查当时那条 `SPEND` 的金额（`credit_ledger_ref_idx` 正是为这类回查建的）。
 *
 * ## 为什么只在 FAILED 时退，PARTIAL 不退
 *
 * `PARTIAL` 意味着至少一页渲染成功并上传了（13.6 明确它是「部分成功 + 产物」，
 * 而不是失败）。用户手里有文件，那一笔钱对应的服务确实交付了 ——
 * 只是少了几页，而 `error` 字段已经如实说明。
 *
 * ## 为什么不用担心「退了钱重试又免费」
 *
 * 与生成侧那条陷阱（见 generation-worker 的 billing.ts）不同：
 * `markRendering` 只从 `QUEUED` 转 `RENDERING`，因此一个已经落到 `FAILED`
 * 的导出被重新投递时会直接 `skipped` —— 它不会再渲染一次。
 * FAILED 就是终态，那一刻退钱是安全的。
 */

export interface ExportBilling {
  /** 渲染彻底失败：把当时扣的那一笔退回去。幂等 */
  refundFailed(exportId: string): Promise<void>;
}

export interface ExportBillingDeps {
  readonly wallet: CreditWalletRepository;
  readonly logger: Logger;
}

export function createExportBilling(deps: ExportBillingDeps): ExportBilling {
  return {
    async refundFailed(exportId) {
      try {
        const spend = await deps.wallet.findSpend({ refType: 'EXPORT', refId: exportId });
        /*
         * 没扣过费：计费当时关着、或那一项没有价目（`estimateExportCost`
         * 算出 0 时刻意不写流水）。什么都不做 —— 凭空退一笔更糟。
         */
        if (spend === null || spend.chargedCr <= 0) return;

        const result = await deps.wallet.refund({
          userId: spend.userId,
          amountCr: spend.chargedCr,
          /*
           * 幂等键按 `exportId`，因此重复调用只退一次。
           *
           * 与 API 侧那条「建行失败就退回」用的是不同的键（那边按导出幂等键）：
           * 两者不会对同一笔扣费同时发生 —— 建行失败的话压根没有队列消息，
           * 渲染这一侧永远看不到它。
           */
          idempotencyKey: `refund:export:${exportId}`,
          refType: 'EXPORT',
          refId: exportId,
        });

        deps.logger.info(
          {
            stage: 'billing',
            export_id: exportId,
            refunded_cr: spend.chargedCr,
            replayed: result.replayed,
          },
          '导出失败，已退回扣费',
        );
      } catch (error) {
        /*
         * 退款失败不能改变导出的结局：`exports` 行此刻已经是 FAILED，
         * 用户看到的是一次明确的失败。抛错只会让 BullMQ 再消费一次，
         * 而那一次因为状态已非 QUEUED 会直接跳过 —— 什么也修不了。
         *
         * 因此吞掉 + error 级日志。补救靠对账（流水里有那条 SPEND
         * 却没有对应的 REFUND）与 `pnpm user:credit` 手工补。
         */
        deps.logger.error(
          { stage: 'billing', export_id: exportId },
          `导出失败后退款失败，需人工补：${String(error)}`,
        );
      }
    },
  };
}
