import { ConfigError } from '@tps/shared';

/** 短信配置先于连接基础设施解析，生产环境不允许开发发送器。 */
export function loadSmsConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const production = env['NODE_ENV'] === 'production';
  const mode = (env['SMS_MODE'] ?? (production ? '' : 'local')).trim().toLowerCase();
  if (mode !== 'local' && mode !== 'aliyun') {
    throw new ConfigError('SMS_MODE 必须显式配置为 local 或 aliyun');
  }
  if (production && mode !== 'aliyun') {
    throw new ConfigError('生产环境 SMS_MODE 必须为 aliyun');
  }
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigError(`缺少短信配置 ${key}`);
    return value;
  };
  const pepper = production
    ? required('SMS_VERIFICATION_PEPPER')
    : env['SMS_VERIFICATION_PEPPER']?.trim() || 'local-development-only';
  if (production && (pepper.length < 32 || pepper === 'local-development-only')) {
    throw new ConfigError('生产环境 SMS_VERIFICATION_PEPPER 必须至少 32 字符且不能使用开发默认值');
  }
  if (mode === 'local') return { mode, pepper, exposeDevCode: true } as const;
  return {
    mode,
    pepper,
    exposeDevCode: false,
    aliyun: {
      accessKeyId: required('ALIBABA_CLOUD_ACCESS_KEY_ID'),
      accessKeySecret: required('ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
      signName: required('ALIYUN_SMS_SIGN_NAME'),
      templateCode: required('ALIYUN_SMS_TEMPLATE_CODE'),
    },
  } as const;
}
