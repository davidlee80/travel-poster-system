import { describe, expect, it } from 'vitest';
import { ALLOWED_LABELS, assertAllowedLabels } from './labels.js';
import { createCounter, registry } from './metrics.js';

describe('指标标签约束（设计稿 21.3、二十章）', () => {
  it('白名单内的标签通过', () => {
    expect(() => assertAllowedLabels('m', ['user_type', 'outcome'])).not.toThrow();
  });

  it('user_id 被运行期校验拒绝', () => {
    // 编译期已由 ValidLabel 拦住；这条测试守住动态构造与非 TS 调用方
    expect(() => assertAllowedLabels('m', ['user_id'])).toThrow(/未登记的指标标签|user_id/);
  });

  it.each(['email', 'plan_id', 'job_id', 'request_id', 'trace_id', 'ip', 'destination'])(
    '高基数字段 %s 不在白名单内',
    (label) => {
      expect(ALLOWED_LABELS as readonly string[]).not.toContain(label);
      expect(() => assertAllowedLabels('m', [label])).toThrow();
    },
  );

  it('user_type 在白名单内（身份类型有界，只有 2 个取值）', () => {
    expect(ALLOWED_LABELS as readonly string[]).toContain('user_type');
  });

  it('createCounter 对未登记标签抛错', () => {
    expect(() =>
      createCounter({
        name: 'tps_test_bad_counter',
        help: 'x',
        // 绕过编译期类型以验证运行期防线
        labelNames: ['user_id'] as never,
      }),
    ).toThrow();
  });

  it('createCounter 注册到共享 registry 并可被抓取', async () => {
    createCounter({
      name: 'tps_test_ok_counter',
      help: '测试计数器',
      labelNames: ['user_type', 'outcome'],
    }).inc({ user_type: 'ANONYMOUS', outcome: 'succeeded' });

    const text = await registry.metrics();
    expect(text).toContain('tps_test_ok_counter');
    expect(text).toContain('user_type="ANONYMOUS"');
  });
});
