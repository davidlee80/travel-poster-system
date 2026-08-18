import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { LOG_REDACT_PATHS, createAuditLogger, createLogger } from './logger.js';

/**
 * 日志脱敏（TP-2-31，设计稿 21.3、二十章）。
 *
 * ## 为什么必须读实际输出
 *
 * 「redact 配好了」是这类约束最常见的失效方式：路径写成 `email` 而不是
 * `*.email` 时只有顶层字段被剥离，嵌套的 `{ user: { email } }` 照样落盘；
 * `remove: true` 与 `censor` 的组合写错时字段会整体消失，看起来也「没泄漏」，
 * 但排查时缺了必要的结构。两种情况下配置对象本身都「看起来是对的」。
 *
 * 因此这里把 logger 接到一个可读的流上，断言序列化后的那一行。
 */

function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, lines: () => chunks };
}

function logOnce(payload: Record<string, unknown>): string {
  const { stream, lines } = capture();
  const logger = createLogger({ service: 'test', level: 'info', destination: stream });
  logger.info(payload, '测试');
  return lines().join('');
}

describe('二十章：禁记字段', () => {
  it.each([
    ['email', { email: 'user@example.com' }, 'user@example.com'],
    ['password', { password: 'hunter2hunter2' }, 'hunter2hunter2'],
    ['password_hash', { password_hash: '$argon2id$abc' }, '$argon2id$abc'],
    ['tp_session', { tp_session: 'opaque-session-token' }, 'opaque-session-token'],
    ['tp_anon', { tp_anon: 'opaque-anon-token' }, 'opaque-anon-token'],
    ['anon_token_hash', { anon_token_hash: 'deadbeef' }, 'deadbeef'],
    ['created_ip', { created_ip: '203.0.113.7' }, '203.0.113.7'],
    ['raw_request', { raw_request: { custom: '我的手机号 13800000000' } }, '13800000000'],
    ['raw_text', { raw_text: '我叫张三，电话 13800000000' }, '张三'],
    ['plan_json', { plan_json: { title: '杭州五日游' } }, '杭州五日游'],
    ['normalized_request', { normalized_request: { destination_name: '苏州' } }, '苏州'],
    [
      'constraint_report',
      { constraint_report: { satisfied: ['accessibility.wheelchair'] } },
      'wheelchair',
    ],
    [
      'retrieval_projection',
      { retrieval_projection: { destination: { name: '别人的杭州行程' } } },
      '别人的杭州行程',
    ],
  ])('%s 的值不落日志', (_name, payload, secret) => {
    const line = logOnce(payload);
    expect(line).not.toContain(secret);
    expect(line).toContain('[REDACTED]');
  });

  it('嵌套一层的同名字段同样被剥离', () => {
    /*
     * 路径写成 `email` 而不是 `*.email` 时这条会失败 ——
     * 而真实的日志调用几乎总是嵌套的（`logger.info({ user: {...} })`）。
     */
    const line = logOnce({ user: { email: 'nested@example.com', user_id: 'u1' } });
    expect(line).not.toContain('nested@example.com');
    expect(line).toContain('u1');
  });

  it('允许记录的身份字段保留', () => {
    // 二十章：user_id（UUID，非个人可识别信息）与 user_type 可记录，
    // 它们是排查与分身份统计的基础，剥掉会让日志失去意义
    const line = logOnce({
      user_id: '3f2b9c40-0000-4000-8000-000000000000',
      user_type: 'ANONYMOUS',
      request_id: 'req-1',
      trace_id: 'trace-1',
      job_id: 'job-1',
      plan_version_id: 'version-1',
      stage: 'GENERATING_PLAN',
    });

    for (const value of [
      '3f2b9c40-0000-4000-8000-000000000000',
      'ANONYMOUS',
      'req-1',
      'trace-1',
      'job-1',
      'version-1',
      'GENERATING_PLAN',
    ]) {
      expect(line).toContain(value);
    }
  });

  it('字段被替换而不是删除', () => {
    /*
     * `remove: true` 会让字段整体消失。那样看起来也「没泄漏」，
     * 但排查时无法区分「没这个字段」与「有但被剥了」——
     * 而这个区别在追查「为什么这个用户的请求没带条件」时是关键。
     */
    const line = logOnce({ email: 'x@example.com' });
    expect(line).toContain('"email":"[REDACTED]"');
  });

  it('禁记清单覆盖二十章表格里的每一项', () => {
    for (const key of [
      'email',
      'tp_session',
      'tp_anon',
      'created_ip',
      'raw_request',
      'plan_json',
      'retrieval_projection',
    ]) {
      // 三层路径都必须在：pino 的 `*` 只匹配一层，
      // 只写 `*.email` 会漏掉最自然的 `logger.info({ email })`
      for (const path of [key, `*.${key}`, `*.*.${key}`]) {
        expect(LOG_REDACT_PATHS, `${path} 未登记`).toContain(path);
      }
    }
  });
});

describe('21.3 的 trace 关联字段（TP-5-02）', () => {
  it('没有活跃 span 时不产生噪声字段', () => {
    /*
     * `@opentelemetry/api` 在无 SDK 时是 no-op：`getActiveSpan()` 返回
     * undefined。此时不该写 `trace_id: null` 或空串 —— 那会让
     * `grep 'trace_id'` 匹配到每一条日志，而这个字段的用途正是筛出有链路的那些。
     *
     * 真实 span 下的行为需要装配 SDK，在 TP-5-03 的测试里验证。
     */
    const line = logOnce({ stage: 'NORMALIZING' });
    const parsed: Record<string, unknown> = JSON.parse(line);

    expect(parsed).not.toHaveProperty('trace_id');
    expect(parsed).not.toHaveProperty('span_id');
    expect(parsed['stage']).toBe('NORMALIZING');
  });

  it('mixin 不影响调用方显式给出的 trace_id', () => {
    /*
     * Worker 侧在没有 SDK 时可能自己带一个（例如从队列消息头读到的）。
     * pino 的 mixin 优先级低于调用参数，因此显式值胜出 —— 这是我们要的：
     * 「上游给了链路 ID」比「本进程没有活跃 span」更可信。
     */
    const line = logOnce({ trace_id: 'from-queue-header' });
    expect(line).toContain('from-queue-header');
  });
});

describe('安全审计日志（二十章的分流）', () => {
  it('审计通道保留 created_ip', () => {
    const { stream, lines } = capture();
    createAuditLogger('test', stream).info({ created_ip: '203.0.113.7' }, '审计');

    const line = lines().join('');
    expect(line).toContain('203.0.113.7');
    expect(line).toContain('"channel":"audit"');
  });

  it('业务通道剥离 created_ip', () => {
    /*
     * 两个通道对同一字段行为相反，这正是「分流」的含义。
     * 若业务 logger 也保留 IP，二十章「与业务日志分流，保留 90 天」
     * 就无从实现 —— 业务日志的保留期比 90 天短，而 IP 会随它一起留下。
     */
    expect(logOnce({ created_ip: '203.0.113.7' })).not.toContain('203.0.113.7');
  });

  it('审计通道仍然剥离凭据与 email', () => {
    const { stream, lines } = capture();
    createAuditLogger('test', stream).info(
      { email: 'user@example.com', tp_session: 'secret' },
      '审计',
    );

    const line = lines().join('');
    expect(line).not.toContain('user@example.com');
    expect(line).not.toContain('secret');
  });
});
