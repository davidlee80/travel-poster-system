import { describe, expect, it } from 'vitest';

import {
  ASSET_WARNING_CODES,
  BLOCKING_DECISIONS,
  DOMAIN_ERRORS,
  JOB_ERRORS,
  PLAN_ERRORS,
  RENDER_ERRORS,
  REQUEST_ERRORS,
  isBlocking,
} from './error-codes.js';

/**
 * 错误码体系（TP-2-07，设计稿 13.7）。
 *
 * 这组测试保证的是「每个码有唯一的 HTTP 与 retryable」——
 * 缺一个字段或写错一个状态码不会让任何功能失败，但会让客户端
 * 无法正确处置：把不可重试的失败当成可重试，用户就会看到反复重试后
 * 仍然失败；反过来把可重试的当成永久失败，偶发抖动会直接暴露给用户。
 */

describe('13.7 错误码表', () => {
  it('四域合并后无重名', () => {
    /*
     * 同名码在两个域里定义时，展开顺序决定谁生效 —— 而两处的
     * httpStatus 很可能不同。这类冲突不会报错，只会让某些响应
     * 带上错误的状态码。
     */
    const counts = new Map<string, number>();
    for (const table of [REQUEST_ERRORS, PLAN_ERRORS, RENDER_ERRORS, JOB_ERRORS]) {
      for (const code of Object.keys(table)) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }

    expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
    expect(Object.keys(DOMAIN_ERRORS)).toHaveLength(counts.size);
  });

  it('每个码都有合法的 HTTP 状态与 retryable', () => {
    for (const [code, definition] of Object.entries(DOMAIN_ERRORS)) {
      expect(definition.httpStatus, `${code} 的状态码越界`).toBeGreaterThanOrEqual(200);
      expect(definition.httpStatus, `${code} 的状态码越界`).toBeLessThan(600);
      expect(typeof definition.retryable, `${code} 缺 retryable`).toBe('boolean');
      expect(definition.message.length, `${code} 缺文案`).toBeGreaterThan(0);
    }
  });

  it('码名符合 <域>_<原因> 命名规则', () => {
    for (const code of Object.keys(DOMAIN_ERRORS)) {
      expect(code, `${code} 不符合命名规则`).toMatch(
        /^(REQ|PLAN|RENDER|EXPORT|JOB|SYS)_[A-Z0-9_]+$/,
      );
    }
  });

  it('REQ 域全部 400 且不可重试（13.7 明确规定）', () => {
    // 请求校验失败是用户输入问题，原样重试必然再次失败。
    // 标成可重试会让客户端自动重发，用户看到的是「转圈很久然后报错」
    for (const [code, definition] of Object.entries(REQUEST_ERRORS)) {
      expect(definition.httpStatus, `${code} 不是 400`).toBe(400);
      expect(definition.retryable, `${code} 被标为可重试`).toBe(false);
    }
  });

  it('REQ 域覆盖 3.1.2 的 N-01～N-12 全部错误码', () => {
    const expected = [
      'REQ_START_DATE_IN_PAST',
      'REQ_DATE_RANGE_INVALID',
      'REQ_TRIP_DAYS_OUT_OF_RANGE',
      'REQ_BUDGET_RANGE_INVALID',
      'REQ_PACE_RANGE_INVALID',
      'REQ_ORIGIN_EQUALS_DESTINATION',
      'REQ_TRAVELER_COUNT_INVALID',
      'REQ_CONDITION_CODE_UNKNOWN',
      'REQ_DATE_FLEXIBILITY_UNSUPPORTED',
      'REQ_MULTI_DESTINATION_UNSUPPORTED',
      'REQ_TEMPLATE_UNKNOWN',
      'REQ_BUDGET_INFEASIBLE',
      // 13.7 另列的两个：结构错误与目的地无法识别
      'REQ_SCHEMA_INVALID',
      'REQ_DESTINATION_UNKNOWN',
    ];
    expect(Object.keys(REQUEST_ERRORS).sort()).toEqual([...expected].sort());
  });

  it('硬约束不可满足是唯一不可重试的生成失败', () => {
    /*
     * PLAN_HARD_CONSTRAINT_UNSATISFIABLE（V-30/V-31）重试不会改变结果，
     * 必须由用户放宽条件。若标成可重试，客户端会反复调用 LLM ——
     * 每次都失败，而每次都花钱。
     */
    const notRetryable = Object.entries(PLAN_ERRORS)
      .filter(([, definition]) => !definition.retryable)
      .map(([code]) => code);

    expect(notRetryable.sort()).toEqual(['PLAN_HARD_CONSTRAINT_UNSATISFIABLE', 'PLAN_NOT_FOUND']);
  });

  it('PLAN_NOT_FOUND 是 404 而不是 403（13.0 防枚举）', () => {
    // 403 会告诉攻击者「这个计划 ID 存在，只是不属于你」
    expect(PLAN_ERRORS.PLAN_NOT_FOUND.httpStatus).toBe(404);
  });

  it('SYS_INTERNAL_ERROR 的文案不含任何内部细节', () => {
    const message = JOB_ERRORS.SYS_INTERNAL_ERROR.message;
    for (const forbidden of ['SQL', 'stack', 'Error', 'null', 'undefined']) {
      expect(message, `兜底文案含内部信息 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('全部用户文案都不泄漏内部细节（13.0）', () => {
    /*
     * 13.0：message「不含内部细节、堆栈、SQL、模型原文」。
     * 前端会直接展示这段文案（AuthPanel 就是这么做的），
     * 因此它同时是安全边界 —— 表名或字段名泄漏出去就是信息泄漏。
     */
    const forbidden = [
      'SELECT',
      'INSERT',
      'plan_json',
      'travel_plan_versions',
      'undefined',
      'null',
      'Exception',
      'stacktrace',
    ];

    for (const [code, definition] of Object.entries(DOMAIN_ERRORS)) {
      for (const word of forbidden) {
        expect(definition.message, `${code} 的文案含 ${word}`).not.toContain(word);
      }
    }
  });

  it('用户文案是中文且以句号结尾', () => {
    // 统一的收尾让前端不必自己补标点，也避免半句话拼接
    for (const [code, definition] of Object.entries(DOMAIN_ERRORS)) {
      expect(definition.message, `${code} 无中文`).toMatch(/[一-龥]/);
      expect(definition.message, `${code} 未以句号结尾`).toMatch(/。$/);
    }
  });
});

describe('ASSET 域', () => {
  it('7 个告警码，且不出现在 HTTP 错误表里', () => {
    /*
     * 13.7：素材错误**全部非阻断**，只写入 generation_jobs.warnings。
     * 它们出现在 HTTP 错误表里就意味着某处会把它们当失败返回 ——
     * 而那会让「景点图缺失」这种小事变成整个任务失败。
     */
    expect(ASSET_WARNING_CODES).toHaveLength(7);

    for (const code of ASSET_WARNING_CODES) {
      expect(Object.keys(DOMAIN_ERRORS), `${code} 混进了 HTTP 错误表`).not.toContain(code);
    }
  });
});

describe('16.3 阻断判定表（TP-4-09）', () => {
  it('16.3 的六个阻断码全部登记为阻断', () => {
    for (const code of [
      'PLAN_SCHEMA_INVALID',
      'PLAN_HARD_CONSTRAINT_UNSATISFIABLE',
      'PLAN_REPAIR_EXHAUSTED',
      'PLAN_PERSIST_FAILED',
      'RENDER_CORE_ASSET_MISSING',
      'RENDER_TEMPLATE_FAILED',
    ]) {
      expect(isBlocking(code), code).toBe(true);
    }
  });

  it('全部 ASSET 告警码都是非阻断（13.7：只写入任务告警）', () => {
    for (const code of ASSET_WARNING_CODES) {
      expect(isBlocking(code), code).toBe(false);
    }
  });

  it('RENDER_OVERFLOW_UNRESOLVED 非阻断（R-24：它压根不走 HTTP 错误路径）', () => {
    expect(isBlocking('RENDER_OVERFLOW_UNRESOLVED')).toBe(false);
  });

  it('两个导出失败非阻断（16.1：重试一次后跳到下一状态，最终仍 COMPLETED）', () => {
    expect(isBlocking('EXPORT_PNG_FAILED')).toBe(false);
    expect(isBlocking('EXPORT_PDF_FAILED')).toBe(false);
  });

  it('未登记的码按阻断处理（宁可明确失败，不要标成已完成但内容不全）', () => {
    expect(isBlocking('SOMETHING_WE_DID_NOT_FORESEE')).toBe(true);
  });

  it('每条决定都带一句降级动作，供排查时对照 16.3', () => {
    for (const [code, decision] of Object.entries(BLOCKING_DECISIONS)) {
      expect(decision.degradation.length, code).toBeGreaterThan(0);
    }
  });
});

describe('16.3 超时码', () => {
  it('任务与队列超时各有专属码，且可重试', () => {
    expect(DOMAIN_ERRORS.JOB_TIMEOUT).toMatchObject({ httpStatus: 504, retryable: true });
    expect(DOMAIN_ERRORS.JOB_TIMEOUT.message.length).toBeGreaterThan(0);
    expect(DOMAIN_ERRORS.JOB_QUEUE_TIMEOUT.retryable).toBe(true);
  });

  it('13.7 的 SYS_DEPENDENCY_UNAVAILABLE 是 503', () => {
    expect(DOMAIN_ERRORS.SYS_DEPENDENCY_UNAVAILABLE.httpStatus).toBe(503);
  });
});
