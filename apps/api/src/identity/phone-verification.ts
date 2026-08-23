import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Redis } from '@tps/queue';

export type VerificationPurpose = 'REGISTER' | 'LOGIN';

export interface SmsSender {
  sendCode(phoneE164: string, code: string): Promise<void>;
}

export interface SendVerificationResult {
  readonly outcome: 'sent' | 'rate_limited' | 'provider_failed';
  readonly retryAfterSeconds?: number;
  readonly devCode?: string;
}

export type VerifyCodeResult = 'valid' | 'invalid' | 'expired' | 'too_many_attempts';

interface StoredCode {
  readonly digest: string;
  readonly attempts: number;
}

export class PhoneVerificationService {
  constructor(
    private readonly redis: Redis,
    private readonly sender: SmsSender,
    private readonly options: {
      readonly pepper: string;
      readonly exposeDevCode: boolean;
      readonly ttlSeconds?: number;
      readonly cooldownSeconds?: number;
      readonly maxAttempts?: number;
    },
  ) {}

  private codeKey(phone: string, purpose: VerificationPurpose): string {
    return `auth:phone-code:${purpose}:${phone}`;
  }

  private cooldownKey(phone: string, purpose: VerificationPurpose): string {
    return `auth:phone-code-cooldown:${purpose}:${phone}`;
  }

  private digest(phone: string, purpose: VerificationPurpose, code: string): string {
    return createHmac('sha256', this.options.pepper)
      .update(`${purpose}:${phone}:${code}`)
      .digest('hex');
  }

  async send(phone: string, purpose: VerificationPurpose): Promise<SendVerificationResult> {
    const cooldownSeconds = this.options.cooldownSeconds ?? 60;
    const locked = await this.redis.set(
      this.cooldownKey(phone, purpose),
      '1',
      'EX',
      cooldownSeconds,
      'NX',
    );
    if (locked !== 'OK') {
      const ttl = await this.redis.ttl(this.cooldownKey(phone, purpose));
      return { outcome: 'rate_limited', retryAfterSeconds: Math.max(1, ttl) };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await this.sender.sendCode(phone, code);
    } catch {
      await this.redis.del(this.cooldownKey(phone, purpose));
      return { outcome: 'provider_failed' };
    }

    const stored: StoredCode = { digest: this.digest(phone, purpose, code), attempts: 0 };
    await this.redis.set(
      this.codeKey(phone, purpose),
      JSON.stringify(stored),
      'EX',
      this.options.ttlSeconds ?? 300,
    );
    return {
      outcome: 'sent',
      ...(this.options.exposeDevCode ? { devCode: code } : {}),
    };
  }

  async verify(
    phone: string,
    purpose: VerificationPurpose,
    code: string,
  ): Promise<VerifyCodeResult> {
    const key = this.codeKey(phone, purpose);
    const raw = await this.redis.get(key);
    if (raw === null) return 'expired';

    let stored: StoredCode;
    try {
      stored = JSON.parse(raw) as StoredCode;
    } catch {
      await this.redis.del(key);
      return 'expired';
    }

    const maxAttempts = this.options.maxAttempts ?? 5;
    if (stored.attempts >= maxAttempts) {
      await this.redis.del(key);
      return 'too_many_attempts';
    }

    const expected = Buffer.from(stored.digest, 'hex');
    const supplied = Buffer.from(this.digest(phone, purpose, code), 'hex');
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      await this.redis.del(key);
      return 'valid';
    }

    const ttl = await this.redis.ttl(key);
    const next = JSON.stringify({ ...stored, attempts: stored.attempts + 1 });
    if (ttl > 0) await this.redis.set(key, next, 'EX', ttl);
    return stored.attempts + 1 >= maxAttempts ? 'too_many_attempts' : 'invalid';
  }
}

export class LocalSmsSender implements SmsSender {
  async sendCode(): Promise<void> {
    // 本地码只通过 send 接口的 dev_code 返回；禁止写日志。
    return Promise.resolve();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 阿里云短信 SendSms 的原生 HTTPS V3 签名适配器。 */
export class AliyunSmsSender implements SmsSender {
  constructor(
    private readonly config: {
      readonly accessKeyId: string;
      readonly accessKeySecret: string;
      readonly signName: string;
      readonly templateCode: string;
    },
  ) {}

  async sendCode(phoneE164: string, code: string): Promise<void> {
    const host = 'dysmsapi.aliyuncs.com';
    const phone = phoneE164.startsWith('+86') ? phoneE164.slice(3) : phoneE164;
    const query = new Map<string, string>([
      ['PhoneNumbers', phone],
      ['SignName', this.config.signName],
      ['TemplateCode', this.config.templateCode],
      ['TemplateParam', JSON.stringify({ code })],
    ]);
    const canonicalQuery = [...query.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
      .join('&');

    const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const nonce = randomUUID();
    const payloadHash = sha256('');
    const headers: Record<string, string> = {
      host,
      'x-acs-action': 'SendSms',
      'x-acs-content-sha256': payloadHash,
      'x-acs-date': date,
      'x-acs-signature-nonce': nonce,
      'x-acs-version': '2017-05-25',
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name]?.trim()}\n`)
      .join('');
    const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const stringToSign = `ACS3-HMAC-SHA256\n${sha256(canonicalRequest)}`;
    const signature = createHmac('sha256', this.config.accessKeySecret)
      .update(stringToSign)
      .digest('hex');
    headers['authorization'] =
      `ACS3-HMAC-SHA256 Credential=${this.config.accessKeyId},` +
      `SignedHeaders=${signedHeaders},Signature=${signature}`;

    const response = await fetch(`https://${host}/?${canonicalQuery}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    const result = (await response.json()) as { Code?: string; Message?: string };
    if (!response.ok || result.Code !== 'OK') {
      throw new Error(`Aliyun SendSms failed: ${result.Code ?? response.status}`);
    }
  }
}
