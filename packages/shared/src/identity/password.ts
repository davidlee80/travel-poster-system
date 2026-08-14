import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * 口令哈希（TP-1-34，设计稿 13.9.2）。
 *
 * Argon2id，参数取 OWASP 2024 建议基线：m=19456 KiB (19 MiB)、t=2、p=1。
 * 选 `@node-rs/argon2` 而不是 `argon2` 原生包：前者提供 linux-x64-gnu 预编译
 * 二进制，不需要镜像里带编译工具链（设计稿 22.3.2 明确要求避免需要本机
 * 编译的方案）。
 *
 * 为什么不是 bcrypt：bcrypt 有 72 字节输入截断，且对 GPU 破解的抵抗力弱于
 * Argon2id。为什么不是 scrypt：参数调优空间小，且 Argon2 是 PHC 竞赛获胜者。
 */

const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** 口令最小长度（设计稿 13.9.2） */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * 弱口令字典。
 *
 * V1 用内置小字典而不是引入 HaveIBeenPwned 之类的外部服务：
 * 后者会让注册路径依赖外部可用性，而注册失败的用户不会重试第二次。
 * 小字典能挡住绝大多数「123456789a」式口令，边际收益已经足够。
 */
const WEAK_PASSWORDS = new Set([
  '1234567890',
  '12345678901',
  '123456789012',
  'password12',
  'password123',
  'qwertyuiop',
  'qwerty12345',
  'abcdefghij',
  'aaaaaaaaaa',
  '1qaz2wsx3e',
  'iloveyou12',
  'admin12345',
  'welcome123',
  'letmein123',
  'passw0rd12',
  'p@ssw0rd12',
  'travel1234',
  'hangzhou12',
]);

export type PasswordRejection =
  | { readonly ok: false; readonly reason: 'TOO_SHORT' }
  | { readonly ok: false; readonly reason: 'IN_WEAK_DICTIONARY' }
  | { readonly ok: false; readonly reason: 'SINGLE_CHARACTER' };

export type PasswordCheck = { readonly ok: true } | PasswordRejection;

/**
 * 口令强度校验。
 *
 * 只做「排除明显不安全」而不强制字符类组合（大小写 + 数字 + 符号）：
 * 强制组合规则会把用户推向 `Password1!` 这种可预测模式，NIST SP 800-63B
 * 已明确建议改为「长度 + 黑名单」。
 */
export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'TOO_SHORT' };
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'IN_WEAK_DICTIONARY' };
  }
  // 「aaaaaaaaaaaa」满足长度但熵极低
  if (new Set(password).size === 1) {
    return { ok: false, reason: 'SINGLE_CHARACTER' };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * 校验口令。
 *
 * 哈希格式非法或校验抛错时返回 false 而不是向上抛 —— 登录失败的原因
 * 不应因「哈希坏了」和「口令错了」而产生可观测差异（13.9.3 防邮箱枚举的
 * 同类考虑）。真正的哈希损坏由日志与告警发现，不由响应差异暴露。
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password, ARGON_OPTIONS);
  } catch {
    return false;
  }
}
