/**
 * 13.5 导出请求的构造（TP-5 补漏）。
 *
 * ## 为什么抽成纯函数
 *
 * 请求体必须满足 `CreateExportRequestSchema` 的 refine：**`SINGLE_DAY` 时
 * `day_numbers` 恰好一天，其余必须为 null**。这条约束在服务端，而违反它的
 * 后果是一个 400 —— 用户点了导出，什么也没发生。
 *
 * 抽出来之后可以用**服务端那份 schema**直接断言（见 export-request.test.ts），
 * 而不是靠人读两遍契约确认字段对得上。组件里写成内联对象也能跑，
 * 但那样这三种组合就只有点一遍界面才能验证。
 */

/** 界面提供的三种导出，对应 13.5 的三种产物组织 */
export type ExportChoice =
  | { readonly kind: 'full-pdf' }
  | { readonly kind: 'all-days-pdf' }
  | { readonly kind: 'single-day-png'; readonly dayNumber: number };

export interface ExportRequestBody {
  readonly format: 'PNG' | 'PDF';
  readonly template_id: string;
  readonly scope: 'ALL_DAYS' | 'SINGLE_DAY' | 'FULL_PLAN';
  readonly day_numbers: readonly number[] | null;
  readonly plan_version_id: string;
}

export interface ExportRequest {
  readonly body: ExportRequestBody;
  /** 进度提示用的中文标签 */
  readonly label: string;
}

/**
 * `plan_version_id` 必传。
 *
 * 缺省时服务端会取「当前版本」，而用户在页面上看的是他打开时的那一版 ——
 * 两者不同时他会拿到一份内容与屏幕不符的 PDF。13.7 的
 * `EXPORT_PLAN_VERSION_MISMATCH` 正是为这种情况准备的，
 * 而不传这个字段的话那个错误码永远不会触发。
 */
export function buildExportRequest(choice: ExportChoice, planVersionId: string): ExportRequest {
  if (choice.kind === 'full-pdf') {
    return {
      body: {
        format: 'PDF',
        template_id: 'travel_full_plan_v1',
        scope: 'FULL_PLAN',
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '完整行程 PDF',
    };
  }

  if (choice.kind === 'all-days-pdf') {
    return {
      body: {
        format: 'PDF',
        template_id: 'travel_infographic_v1',
        scope: 'ALL_DAYS',
        // ALL_DAYS 的天数由服务端按「实际落了 ViewModel 的那些天」决定（13.5）
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '每日信息图 PDF',
    };
  }

  return {
    body: {
      format: 'PNG',
      template_id: 'travel_infographic_v1',
      scope: 'SINGLE_DAY',
      day_numbers: [choice.dayNumber],
      plan_version_id: planVersionId,
    },
    label: `第 ${String(choice.dayNumber)} 天长图`,
  };
}
