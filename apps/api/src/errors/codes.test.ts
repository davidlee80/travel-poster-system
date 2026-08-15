import { describe, expect, it } from 'vitest';
import {
  AUTH_ERRORS,
  ERROR_CATALOG,
  buildErrorBody,
  errorDefinition,
  type ErrorCode,
} from './codes.js';

describe('错误码体系（13.7、13.9.6）', () => {
  const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];

  it('每个码都有 HTTP 状态、retryable 与中文提示', () => {
    /*
     * `JOB_CANCELLED` 是全表唯一的非 4xx/5xx 码：13.7 给它 200 ——
     * 取消是用户主动行为，不是错误，但它仍然通过同一个响应信封返回，
     * 因此留在码表里。
     *
     * 显式列出而不是把下界放宽到 200：放宽后任何新增的「2xx 错误码」
     * 都会静默通过，而那通常意味着某个失败被当成了成功。
     */
    const nonErrorCodes = new Set<ErrorCode>(['JOB_CANCELLED']);

    for (const code of codes) {
      const def = errorDefinition(code);
      if (!nonErrorCodes.has(code)) {
        expect(def.httpStatus, code).toBeGreaterThanOrEqual(400);
      }
      expect(def.httpStatus, code).toBeLessThan(600);
      expect(typeof def.retryable, code).toBe('boolean');
      expect(def.message, code).toMatch(/\S/);
    }

    expect([...codes].filter((code) => errorDefinition(code).httpStatus < 400)).toEqual([
      'JOB_CANCELLED',
    ]);
  });

  it('4xx 中只有 429 可重试（其余 4xx 是客户端问题，重试无用）', () => {
    for (const code of codes) {
      const def = errorDefinition(code);
      if (def.httpStatus >= 400 && def.httpStatus < 500 && def.httpStatus !== 429) {
        expect(def.retryable, `${code} 是 ${def.httpStatus}，不应可重试`).toBe(false);
      }
    }
  });

  it('5xx 全部可重试', () => {
    for (const code of codes) {
      const def = errorDefinition(code);
      if (def.httpStatus >= 500) {
        expect(def.retryable, `${code} 是 ${def.httpStatus}，应可重试`).toBe(true);
      }
    }
  });

  it('配额耗尽是 429 但不可重试（无短期恢复路径，重试只会再撞一次）', () => {
    expect(AUTH_ERRORS.AUTH_QUOTA_EXCEEDED.httpStatus).toBe(429);
    expect(AUTH_ERRORS.AUTH_QUOTA_EXCEEDED.retryable).toBe(false);
  });

  it('限流是 429 且可重试', () => {
    expect(AUTH_ERRORS.AUTH_RATE_LIMITED.retryable).toBe(true);
    expect(AUTH_ERRORS.AUTH_ANON_CREATION_RATE_LIMITED.retryable).toBe(true);
  });

  it('用户可见提示不含内部细节（13.0）', () => {
    const forbidden = [
      'SQL',
      'select ',
      'undefined',
      'null',
      'Error:',
      'stack',
      'postgres',
      'redis',
      'exception',
    ];

    for (const code of codes) {
      const message = errorDefinition(code).message.toLowerCase();
      for (const word of forbidden) {
        expect(message, `${code} 的提示不应含「${word}」`).not.toContain(word.toLowerCase());
      }
    }
  });

  it('凭据错误不区分邮箱不存在与口令错误（防枚举）', () => {
    expect(AUTH_ERRORS.AUTH_CREDENTIALS_INVALID.message).toBe('邮箱或密码不正确。');
    // 不应存在「邮箱不存在」这类单独的码
    expect(codes).not.toContain('AUTH_EMAIL_NOT_FOUND');
  });

  it('IDENTITY_REQUIRED 与 SESSION_INVALID 是两个不同的码（客户端处置不同）', () => {
    expect(AUTH_ERRORS.AUTH_IDENTITY_REQUIRED.message).not.toBe(
      AUTH_ERRORS.AUTH_SESSION_INVALID.message,
    );
  });
});

describe('错误响应体（13.0）', () => {
  it('包含六个必需字段', () => {
    const body = buildErrorBody('AUTH_CREDENTIALS_INVALID', {
      requestId: 'req-1',
      traceId: 'trace-1',
    });

    expect(body.error.code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(body.error.message).toMatch(/\S/);
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBe('req-1');
    expect(body.error.trace_id).toBe('trace-1');
  });

  it('field 仅在提供时出现（校验类错误才有）', () => {
    const withoutField = buildErrorBody('SYS_INTERNAL_ERROR', {
      requestId: 'r',
      traceId: 't',
    });
    expect(withoutField.error.field).toBeUndefined();

    const withField = buildErrorBody('REQ_SCHEMA_INVALID', {
      requestId: 'r',
      traceId: 't',
      field: 'trip.dates.end_date',
    });
    expect(withField.error.field).toBe('trip.dates.end_date');
  });
});
