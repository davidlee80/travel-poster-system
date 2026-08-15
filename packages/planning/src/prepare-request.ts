import {
  TravelRequestUISchema,
  type NormalizedTravelRequest,
  type RequestErrorCode,
} from '@tps/schemas';

import { checkRequestConflicts, todayInTimezone, type RequestViolation } from './conflicts.js';
import { normalizeTravelRequest } from './normalize.js';

/**
 * 请求预处理入口（3.1）：解析 → 标准化 → 冲突检查。
 *
 * 三步的顺序不能变，且每一步的失败形态不同：
 *
 *   1. **schema 解析**失败 → `REQ_SCHEMA_INVALID`。连字段都读不出来，
 *      无法给出具体的 `field`；
 *   2. **标准化**不会失败（纯计算，见 normalize.ts）；
 *   3. **冲突检查**失败 → 具体的 `REQ_*` 码 + `field`，可以一次报多条。
 *
 * 把三步合成一个函数，是为了让「未标准化就检查」或「未检查就入队」
 * 在调用侧不可能发生 —— 后者会让一次无效请求白花一次 LLM 调用。
 */

export type PrepareRequestResult =
  | { readonly ok: true; readonly normalized: NormalizedTravelRequest }
  | {
      readonly ok: false;
      readonly code: RequestErrorCode;
      readonly violations: readonly RequestViolation[];
      /** schema 解析失败时的字段路径，供 13.7 的 `field` 使用 */
      readonly field: string | undefined;
    };

export interface PrepareRequestOptions {
  /** 当前时刻。显式传入让 N-01 的边界日可测（见 conflicts.ts） */
  readonly now: Date;
}

export function prepareTravelRequest(
  raw: unknown,
  options: PrepareRequestOptions,
): PrepareRequestResult {
  const parsed = TravelRequestUISchema.safeParse(raw);

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      code: 'REQ_SCHEMA_INVALID',
      violations: [],
      /*
       * 只取第一个 issue 的路径。Zod 会报出全部问题，但 13.7 的错误体
       * 只有一个 `field` —— 而结构性错误通常是客户端 bug（版本不匹配、
       * 字段拼错），用户无法逐项修正，给一个定位点足够。
       */
      field: first === undefined ? undefined : first.path.join('.'),
    };
  }

  const ui = parsed.data;
  const normalized = normalizeTravelRequest(ui);

  const violations = checkRequestConflicts(ui, normalized, {
    todayInRequestTimezone: todayInTimezone(ui.timezone, options.now),
  });

  if (violations.length > 0) {
    /*
     * 多条违规时，返回的 `code` 取**第一条**。
     *
     * 13.7 的错误体只有一个 code，而客户端要靠它分支。取第一条而不是
     * 最严重的一条：N-01～N-12 之间没有严重度差别（全部 400 且不可重试），
     * 而按声明顺序返回是确定的 —— 「最严重」需要一套排序规则，
     * 而那套规则会成为第二个真相源。完整列表在 `violations` 里，
     * 前端可以据此高亮全部出错项。
     */
    return {
      ok: false,
      code: violations[0]!.code,
      violations,
      field: violations[0]!.field,
    };
  }

  return { ok: true, normalized };
}
