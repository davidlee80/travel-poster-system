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

/** 结果页提供的导出预设；请求格式仍只有 PNG/PDF。 */
export type ExportChoice =
  | { readonly kind: 'full-pdf' }
  | { readonly kind: 'full-png' }
  | { readonly kind: 'all-days-pdf' }
  | { readonly kind: 'all-days-png' }
  | { readonly kind: 'single-day-png'; readonly dayNumber: number }
  | { readonly kind: 'single-day-pdf'; readonly dayNumber: number };

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
export function buildExportRequest(
  choice: ExportChoice,
  planVersionId: string,
  /**
   * 这份计划的样式套件（R-85），取自 ViewModel 的 `template_id`。
   *
   * 三种导出都用同一套 —— 原先这里按导出种类写死两个不同的值
   * （全览 PDF 用 travel_full_plan_v1、日页用 travel_infographic_v1），
   * 那是把页型当模板的写法。
   *
   * 必须与生成时那一套一致：导出侧会校验该套件有对应的 presentation，
   * 不一致会直接被拒（而不是渲出一份空白产物）。
   */
  templateId: string,
): ExportRequest {
  if (choice.kind === 'full-pdf') {
    return {
      body: {
        format: 'PDF',
        template_id: templateId,
        scope: 'FULL_PLAN',
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '完整行程 PDF',
    };
  }

  if (choice.kind === 'full-png') {
    return {
      body: {
        format: 'PNG',
        template_id: templateId,
        scope: 'FULL_PLAN',
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '完整攻略长图',
    };
  }

  if (choice.kind === 'all-days-pdf') {
    return {
      body: {
        format: 'PDF',
        template_id: templateId,
        scope: 'ALL_DAYS',
        // ALL_DAYS 的天数由服务端按「实际落了 ViewModel 的那些天」决定（13.5）
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '每日信息图 PDF',
    };
  }

  if (choice.kind === 'all-days-png') {
    return {
      body: {
        format: 'PNG',
        template_id: templateId,
        scope: 'ALL_DAYS',
        day_numbers: null,
        plan_version_id: planVersionId,
      },
      label: '全部每日攻略 PNG',
    };
  }

  return {
    body: {
      format: choice.kind === 'single-day-pdf' ? 'PDF' : 'PNG',
      template_id: templateId,
      scope: 'SINGLE_DAY',
      day_numbers: [choice.dayNumber],
      plan_version_id: planVersionId,
    },
    label:
      choice.kind === 'single-day-pdf'
        ? `第 ${String(choice.dayNumber)} 天 PDF`
        : `第 ${String(choice.dayNumber)} 天长图`,
  };
}
