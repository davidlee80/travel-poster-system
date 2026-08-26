import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { COOKIE_NAMES, type QuotaGuard } from '@tps/shared';
import { buildErrorBody, errorDefinition, type ErrorCode } from '../errors/codes.js';
import type { CreditsService } from '../credits/service.js';
import { recordIdentityEvent, recordIdentityType } from '../identity/metrics.js';
import type { Identity, IdentityService } from '../identity/service.js';
import type { PhoneVerificationService } from '../identity/phone-verification.js';
import { applyCookies, parseCookies } from './identity-context.js';

/**
 * 身份与账号端点（设计稿 13.9）。
 *
 * 只做三件事：解析 HTTP、调用 IdentityService、写响应。
 * 全部业务判断在 service 层，因此这一层的测试只需覆盖 HTTP 映射
 * （状态码、Cookie 头、错误体形态），业务分支由 service.test.ts 穷尽覆盖。
 */

const PhoneSchema = z
  .string()
  .trim()
  .regex(/^(?:\+?86)?1[3-9]\d{9}$/, '手机号格式不正确')
  .transform((value) => `+86${value.replace(/^\+?86/, '')}`);

const PhoneRegisterBodySchema = z.object({
  phone: PhoneSchema,
  verification_code: z.string().regex(/^\d{6}$/),
  password: z.string().min(1).nullable().optional(),
  display_name: z.string().trim().max(100).nullable().optional(),
});

const LegacyRegisterBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('邮箱格式不正确')),
  password: z.string().min(1),
  display_name: z.string().trim().max(100).nullable().optional(),
});

const RegisterBodySchema = z.union([PhoneRegisterBodySchema, LegacyRegisterBodySchema]);

const LegacyLoginBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('邮箱格式不正确')),
  password: z.string().min(1),
});

const PhoneLoginBodySchema = z.discriminatedUnion('login_type', [
  z.object({
    phone: PhoneSchema,
    login_type: z.literal('CODE'),
    verification_code: z.string().regex(/^\d{6}$/),
  }),
  z.object({ phone: PhoneSchema, login_type: z.literal('PASSWORD'), password: z.string().min(1) }),
]);

const LoginBodySchema = z.union([PhoneLoginBodySchema, LegacyLoginBodySchema]);

const SendCodeBodySchema = z.object({
  phone: PhoneSchema,
  purpose: z.enum(['REGISTER', 'LOGIN']),
});

/**
 * 改口令。
 *
 * 两个字段都只校验「非空」，**长度与强度交给 `checkPasswordStrength`** ——
 * 在 schema 里再写一遍 `.min(10)` 会产生第二套强度规则，
 * 而两套规则分叉时先撞上的是 schema 那套，返回的却是 `REQ_SCHEMA_INVALID`
 * 而不是 `AUTH_PASSWORD_TOO_WEAK`，用户看不到「密码强度不足」的说明。
 */
const ChangePasswordBodySchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
});

export interface AuthRoutesDeps {
  readonly identity: IdentityService;
  readonly quota: QuotaGuard;
  readonly secureCookies: boolean;
  readonly phoneVerification?: PhoneVerificationService;
  /** CR 钱包（C-3）。未提供时会话响应里没有 `wallet` 字段 */
  readonly credits?: CreditsService;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extra?: { readonly retryAfterSeconds?: number | null; readonly field?: string },
): FastifyReply {
  const def = errorDefinition(code);
  if (extra?.retryAfterSeconds != null) {
    reply.header('retry-after', String(extra.retryAfterSeconds));
  }
  return reply.code(def.httpStatus).send(
    buildErrorBody(code, {
      requestId: request.id,
      traceId: 'unavailable',
      ...(extra?.field === undefined ? {} : { field: extra.field }),
    }),
  );
}

/** 客户端 IP。trustProxy 已开启，因此 request.ip 已考虑 X-Forwarded-For。 */
function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

interface SessionResponse {
  readonly user_type: Identity['userType'];
  readonly user_id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly has_password: boolean;
  readonly display_name: string | null;
  /**
   * 次数配额。
   *
   * C-3 之后它**不再是产品概念** —— 用户看到的是 CR（见 `wallet`），
   * 而这几个数被提到很高的兜底值，只用于防滥用。字段保留不动：
   * 删它是破坏性契约变更，而 13.x 明确邀请第三方替换呈现层。
   */
  readonly quota: {
    readonly daily_remaining: number;
    readonly monthly_remaining: number;
    readonly reset_at: string;
  };
  /**
   * CR 钱包（C-3）。**只在装配了计费、且身份是注册用户时出现。**
   *
   * 匿名身份不进货币体系（产品决策：必须注册才能使用），给它一个
   * `balance_cr: 0` 会让前端渲染一个永远不够用的钱包，而用户无从知道
   * 该去注册。字段缺席让前端只有一种判断：有钱包才画钱包。
   */
  readonly wallet?: {
    readonly balance_cr: number;
    readonly held_cr: number;
    readonly balance_cny: string;
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { identity, quota, secureCookies } = deps;

  async function sessionResponse(id: Identity): Promise<SessionResponse> {
    const remaining = await quota.peekRemaining({
      userId: id.userId,
      userType: id.userType,
      dailyQuotaOverride: id.dailyQuota,
      monthlyQuotaOverride: id.monthlyQuota,
    });

    const credits = deps.credits;
    const wallet =
      credits === undefined || id.userType === 'ANONYMOUS'
        ? null
        : await credits.balance(id.userId);

    return {
      user_type: id.userType,
      // 仅供问题反馈，不作为任何鉴权凭据（13.9.1）
      user_id: id.userId,
      email: id.email,
      phone: id.phone,
      has_password: id.hasPassword,
      display_name: id.displayName,
      quota: {
        daily_remaining: remaining.dailyRemaining,
        monthly_remaining: remaining.monthlyRemaining,
        reset_at: remaining.resetAt,
      },
      ...(wallet === null || credits === undefined
        ? {}
        : {
            wallet: {
              balance_cr: wallet.balanceCr,
              held_cr: wallet.heldCr,
              balance_cny: credits.cnyText(wallet.balanceCr),
            },
          }),
    };
  }

  /**
   * 13.9.1 获取当前身份。
   *
   * 无任何身份 Cookie 时**自动创建匿名用户** —— 前端在应用启动时调一次，
   * 之后所有请求都带上了身份。
   */
  app.get('/api/v1/auth/session', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);

    const result = await identity.resolve({
      anonCookie: cookies[COOKIE_NAMES.anonymous],
      sessionCookie: cookies[COOKIE_NAMES.session],
      ip: clientIp(request),
      allowAnonymousCreation: true,
    });

    if (result.outcome === 'anon_creation_rate_limited') {
      recordIdentityEvent('anon_created', 'rate_limited');
      return fail(request, reply, 'AUTH_ANON_CREATION_RATE_LIMITED', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    if (result.outcome === 'identity_required') {
      /*
       * P7：匿名入口关闭时会走到这里 —— 会话端点不再自动建号。
       *
       * 返回 401 而不是 200 + `{authenticated: false}`：13.0 的错误体是统一
       * 契约，为「未登录」单开一种成功响应会让客户端多一条分支，
       * 而它要做的事（引导注册）与拿到 401 时完全一样。
       * 前端把 401 当作正常的「未登录」状态处理（见 SessionProvider）。
       *
       * 开关打开时这里仍然不可达（`allowAnonymousCreation: true` 会去建号），
       * 因此这个分支同时是类型穷尽与新行为两用。
       */
      applyCookies(reply, result.cookies, secureCookies);
      if (result.cookies.length > 0) {
        recordIdentityEvent('anonymous_rejected', 'rejected');
      }
      return fail(request, reply, 'AUTH_IDENTITY_REQUIRED');
    }

    applyCookies(reply, result.cookies, secureCookies);

    if (result.pendingMerge !== null) {
      try {
        await identity.completePendingMerge(
          result.pendingMerge.anonymousUserId,
          result.identity.userId,
        );
        recordIdentityEvent('merge', 'succeeded');
      } catch {
        recordIdentityEvent('merge', 'failed');
        return fail(request, reply, 'AUTH_MERGE_FAILED');
      }
    }

    recordIdentityType(result.identity.userType);
    return reply.code(200).send(await sessionResponse(result.identity));
  });

  /** 13.9.2 注册（含匿名原地升级） */
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = RegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: parsed.error.issues[0]?.path.join('.') ?? 'body',
      });
    }

    const cookies = parseCookies(request.headers.cookie);
    let result;
    if ('phone' in parsed.data) {
      if (deps.phoneVerification === undefined) {
        return fail(request, reply, 'AUTH_SMS_PROVIDER_UNAVAILABLE');
      }
      const verified = await deps.phoneVerification.verify(
        parsed.data.phone,
        'REGISTER',
        parsed.data.verification_code,
      );
      if (verified === 'too_many_attempts') {
        return fail(request, reply, 'AUTH_VERIFICATION_CODE_RATE_LIMITED', {
          field: 'verification_code',
        });
      }
      if (verified !== 'valid') {
        return fail(request, reply, 'AUTH_VERIFICATION_CODE_INVALID', {
          field: 'verification_code',
        });
      }
      result = await identity.registerPhone({
        phone: parsed.data.phone,
        password: parsed.data.password?.trim() || null,
        displayName: parsed.data.display_name ?? null,
        anonCookie: cookies[COOKIE_NAMES.anonymous],
      });
    } else {
      result = await identity.register({
        email: parsed.data.email,
        password: parsed.data.password,
        displayName: parsed.data.display_name ?? null,
        anonCookie: cookies[COOKIE_NAMES.anonymous],
      });
    }

    switch (result.outcome) {
      case 'email_taken':
        recordIdentityEvent('register', 'rejected');
        return fail(request, reply, 'AUTH_EMAIL_ALREADY_REGISTERED', { field: 'email' });
      case 'phone_taken':
        recordIdentityEvent('register', 'rejected');
        return fail(request, reply, 'AUTH_PHONE_ALREADY_REGISTERED', { field: 'phone' });
      case 'password_too_weak':
        recordIdentityEvent('register', 'rejected');
        return fail(request, reply, 'AUTH_PASSWORD_TOO_WEAK', { field: 'password' });
      case 'anonymous_already_upgraded':
        recordIdentityEvent('upgrade', 'rejected');
        return fail(request, reply, 'AUTH_ANONYMOUS_ALREADY_UPGRADED');
      case 'registered':
        applyCookies(reply, result.cookies, secureCookies);
        recordIdentityEvent(result.upgraded ? 'upgrade' : 'register', 'succeeded');
        /*
         * 注册赠送（C-5）。**在 `sessionResponse` 之前** ——
         * 那一步会读钱包，顺序反了的话新用户拿到的第一份会话里余额是 0，
         * 而前端据它决定生成按钮禁不禁用：用户注册完看到的是「余额不足」。
         *
         * 发放失败不影响这次注册，理由见 `grantSignup`。
         */
        await deps.credits?.grantSignup(result.identity.userId);
        return reply.code(201).send(await sessionResponse(result.identity));
    }
  });

  /** 13.9.3 登录（副作用含 13.9.4 匿名归并） */
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // 登录的校验错误也用通用码，不暴露「邮箱格式」之外的信息
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: parsed.error.issues[0]?.path.join('.') ?? 'body',
      });
    }

    const cookies = parseCookies(request.headers.cookie);
    let result;
    if ('phone' in parsed.data) {
      let codeVerified = false;
      if (parsed.data.login_type === 'CODE') {
        if (deps.phoneVerification === undefined) {
          return fail(request, reply, 'AUTH_SMS_PROVIDER_UNAVAILABLE');
        }
        const verified = await deps.phoneVerification.verify(
          parsed.data.phone,
          'LOGIN',
          parsed.data.verification_code,
        );
        if (verified === 'too_many_attempts') {
          return fail(request, reply, 'AUTH_VERIFICATION_CODE_RATE_LIMITED', {
            field: 'verification_code',
          });
        }
        if (verified !== 'valid') {
          return fail(request, reply, 'AUTH_VERIFICATION_CODE_INVALID', {
            field: 'verification_code',
          });
        }
        codeVerified = true;
      }
      result = await identity.loginPhone({
        phone: parsed.data.phone,
        ...('password' in parsed.data ? { password: parsed.data.password } : {}),
        codeVerified,
        anonCookie: cookies[COOKIE_NAMES.anonymous],
        ip: clientIp(request),
      });
    } else {
      result = await identity.login({
        email: parsed.data.email,
        password: parsed.data.password,
        anonCookie: cookies[COOKIE_NAMES.anonymous],
        ip: clientIp(request),
      });
    }

    switch (result.outcome) {
      case 'invalid_credentials':
        recordIdentityEvent('login', 'rejected');
        return fail(request, reply, 'AUTH_CREDENTIALS_INVALID');
      case 'rate_limited':
        recordIdentityEvent('login', 'rate_limited');
        return fail(request, reply, 'AUTH_RATE_LIMITED', {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      case 'logged_in':
        applyCookies(reply, result.cookies, secureCookies);
        recordIdentityEvent('login', 'succeeded');
        if (result.merged !== null) recordIdentityEvent('merge', 'succeeded');
        return reply.code(200).send(await sessionResponse(result.identity));
    }
  });

  app.post('/api/v1/auth/sms/send', async (request, reply) => {
    const parsed = SendCodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: parsed.error.issues[0]?.path.join('.') ?? 'body',
      });
    }
    if (deps.phoneVerification === undefined) {
      return fail(request, reply, 'AUTH_SMS_PROVIDER_UNAVAILABLE');
    }
    const result = await deps.phoneVerification.send(parsed.data.phone, parsed.data.purpose);
    if (result.outcome === 'rate_limited') {
      return fail(request, reply, 'AUTH_VERIFICATION_CODE_RATE_LIMITED', {
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
      });
    }
    if (result.outcome === 'provider_failed') {
      return fail(request, reply, 'AUTH_SMS_PROVIDER_UNAVAILABLE');
    }
    return reply.code(200).send({
      sent: true,
      expires_in_seconds: 300,
      ...(result.devCode === undefined ? {} : { dev_code: result.devCode }),
    });
  });

  /** 13.9.3 登出 */
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const mutations = await identity.logout(cookies[COOKIE_NAMES.session]);

    applyCookies(reply, mutations, secureCookies);
    recordIdentityEvent('logout', 'succeeded');
    return reply.code(204).send();
  });

  /**
   * 改口令（13.9.2），兼 13.0 账号级端点对匿名身份的拦截（TP-1-37）。
   *
   * 这个端点原先只做拦截、逻辑返回 501。补上实现是因为「忘了口令」在此之前
   * **没有任何出路**：账号只有邮箱与口令两个凭据，而 V1 没有邮件发送能力，
   * 所以自助找回做不了 —— 至少要让记得旧口令的用户能改掉它。
   *
   * 成功时会下发新的会话 Cookie：`changePassword` 吊销了该用户的全部会话
   * （含当前这一个），当前设备靠这个新 Cookie 留在登录态。
   */
  app.post('/api/v1/auth/password', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);

    const result = await identity.resolve({
      anonCookie: cookies[COOKIE_NAMES.anonymous],
      sessionCookie: cookies[COOKIE_NAMES.session],
      ip: clientIp(request),
      // 账号级端点不现场建号
      allowAnonymousCreation: false,
    });

    if (result.outcome !== 'resolved') {
      return fail(request, reply, 'AUTH_IDENTITY_REQUIRED');
    }
    if (result.identity.userType === 'ANONYMOUS') {
      return fail(request, reply, 'AUTH_ANONYMOUS_FORBIDDEN');
    }

    /*
     * 校验放在身份拦截**之后**。
     *
     * 反过来的话，匿名请求会先因为「body 格式不对」拿到 400 —— 而它真正的
     * 问题是没有账号。TP-1-37 那条契约（匿名访问账号级端点得 403）也就
     * 取决于请求体拼得对不对了。
     */
    const parsed = ChangePasswordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(request, reply, 'REQ_SCHEMA_INVALID', {
        field: parsed.error.issues[0]?.path.join('.') ?? 'body',
      });
    }

    const changed = await identity.changePassword({
      userId: result.identity.userId,
      currentPassword: parsed.data.current_password,
      newPassword: parsed.data.new_password,
      ip: clientIp(request),
    });

    switch (changed.outcome) {
      case 'current_password_invalid':
        recordIdentityEvent('password_change', 'rejected');
        return fail(request, reply, 'AUTH_CURRENT_PASSWORD_INVALID', {
          field: 'current_password',
        });
      case 'rate_limited':
        recordIdentityEvent('password_change', 'rate_limited');
        return fail(request, reply, 'AUTH_RATE_LIMITED', {
          retryAfterSeconds: changed.retryAfterSeconds,
        });
      case 'password_too_weak':
        recordIdentityEvent('password_change', 'rejected');
        return fail(request, reply, 'AUTH_PASSWORD_TOO_WEAK', { field: 'new_password' });
      case 'account_unavailable':
        recordIdentityEvent('password_change', 'failed');
        return fail(request, reply, 'AUTH_SESSION_INVALID');
      case 'changed':
        applyCookies(reply, changed.cookies, secureCookies);
        recordIdentityEvent('password_change', 'succeeded');
        /*
         * 204 而不是 200 + 会话信息：改口令不改变身份或配额，回一份
         * `SessionResponse` 会让前端以为需要拿它去覆盖本地状态。
         * 新的会话 Cookie 在响应头里，浏览器自己会用。
         */
        return reply.code(204).send();
    }
  });
}
