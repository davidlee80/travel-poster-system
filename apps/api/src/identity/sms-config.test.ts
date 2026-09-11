import { describe, expect, it } from 'vitest';
import { loadSmsConfig } from './sms-config.js';

const production = {
  NODE_ENV: 'production',
  SMS_MODE: 'aliyun',
  SMS_VERIFICATION_PEPPER: 'isolated-test-pepper-not-for-deployment',
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'test-id',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-secret',
  ALIYUN_SMS_SIGN_NAME: '测试签名',
  ALIYUN_SMS_TEMPLATE_CODE: 'test-template',
};

describe('短信启动配置', () => {
  it.each([undefined, '', 'local', 'typo'])('生产模式拒绝短信模式 %s', (mode) => {
    expect(() => loadSmsConfig({ ...production, SMS_MODE: mode })).toThrow(/SMS_MODE/);
  });
  it.each([
    'SMS_VERIFICATION_PEPPER',
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_CODE',
  ])('缺失 %s 时拒绝启动且错误不包含密钥', (key) => {
    expect(() => loadSmsConfig({ ...production, [key]: ' ' })).toThrow(key);
  });
  it.each(['short', 'local-development-only'])('生产拒绝弱 pepper', (pepper) => {
    expect(() => loadSmsConfig({ ...production, SMS_VERIFICATION_PEPPER: pepper })).toThrow(
      /PEPPER/,
    );
  });
  it('生产 aliyun 永不暴露测试码', () => {
    expect(loadSmsConfig(production)).toMatchObject({ mode: 'aliyun', exposeDevCode: false });
  });
  it('开发环境默认 local，未知模式仍然报错', () => {
    expect(loadSmsConfig({ NODE_ENV: 'development' })).toMatchObject({
      mode: 'local',
      exposeDevCode: true,
    });
    expect(() => loadSmsConfig({ NODE_ENV: 'test', SMS_MODE: 'aliynu' })).toThrow(/SMS_MODE/);
  });
});
