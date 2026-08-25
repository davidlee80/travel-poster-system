import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { buildErrorBody, errorDefinition, type ErrorCode } from '../errors/codes.js';
import type { CreditsService } from '../credits/service.js';
import { resolveIdentity, type IdentityContextDeps } from './identity-context.js';

/**
 * CR 钱包端点（C-3）。
 *
 * ```text
 * GET  /api/v1/credits/wallet   余额与冻结额
 * POST /api/v1/credits/quote    一次生成要多少 CR、够不够
 * GET  /api/v1/credits/ledger   消费流水（倒序翻页）
 * ```
 *
 * ## 为什么报价是端点，而不是把价目表下发给浏览器
 *
 * 两个理由，第二个是决定性的：
 *
 * 1. 价目表是运营数据（含供应商模型名与我们的售价），没有理由进浏览器；
 * 2. 下发之后前端与服务端各算一份，两份算法迟早分叉 —— 而分叉的表现是
 *    **「按钮说够、提交被拒」**，用户能看到的只有一个 402。
 *
 * 因此「够不够」这个判断由服务端给结论（`sufficient`），前端只负责禁用按钮。
 *
 * ## 三个端点都拒绝匿名身份
 *
 * 产品决策是「必须注册才能使用」，匿名身份不进货币体系。返回 403 而不是
 * 「余额 0」：后者会让前端渲染一个永远不够用的钱包，而用户无从知道该注册。
 */

const LedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** 游标：上一页最后一条的 `created_at`。用时间而非 offset，理由见仓储层 */
  before: z.string().datetime().optional(),
});

/**
 * 报价只要天数。
 *
 * 不接整份 `TravelRequestUI`：报价是**展示用的估算**，用户还在填表时就想
 * 看到「大概多少钱」，而那时表单必然不完整。权威金额在生成端点按标准化后的
 * 天数现算（见 `travel-plans.ts` 的预留），因此这里收一个客户端给的天数
 * 不构成绕过 —— 少报了也不会少扣。
 */
const QuoteBodySchema = z.object({
  total_days: z.coerce.number().int().min(1).max(14),
});

export interface CreditRoutesDeps extends IdentityContextDeps {
  readonly credits: CreditsService;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  field?: string,
): FastifyReply {
  const definition = errorDefinition(code);
  return reply.code(definition.httpStatus).send(
    buildErrorBody(code, {
      requestId: request.id,
      traceId: 'unavailable',
      ...(field === undefined ? {} : { field }),
    }),
  );
}

export function registerCreditRoutes(app: FastifyInstance, deps: CreditRoutesDeps): void {
  const { credits } = deps;

  /** 解析身份并拒绝匿名。返回 null 时响应已写好 */
  async function requireRegistered(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> {
    const resolved = await resolveIdentity(deps, request, reply, {
      allowAnonymousCreation: false,
    });
    if (resolved === null) return null;
    if (resolved.identity.userType === 'ANONYMOUS') {
      fail(request, reply, 'AUTH_ANONYMOUS_FORBIDDEN');
      return null;
    }
    return resolved.identity.userId;
  }

  app.get('/api/v1/credits/wallet', async (request, reply) => {
    const userId = await requireRegistered(request, reply);
    if (userId === null) return reply;

    const balance = await credits.balance(userId);
    return reply.code(200).send({
      balance_cr: balance.balanceCr,
      /* 生成中的任务冻结的额度。展示成「处理中」而不是从余额里消失 */
      held_cr: balance.heldCr,
      /*
       * 人民币等值由服务端算。前端没有 `CREDIT_CR_PER_CNY`，自己算需要
       * 硬编码一个比率 —— 而改比率时那个硬编码不会跟着改。
       */
      balance_cny: credits.cnyText(balance.balanceCr),
    });
  });

  app.post('/api/v1/credits/quote', async (request, reply) => {
    const userId = await requireRegistered(request, reply);
    if (userId === null) return reply;

    const parsed = QuoteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        request,
        reply,
        'REQ_SCHEMA_INVALID',
        parsed.error.issues[0]?.path.join('.') ?? 'body',
      );
    }

    const quote = await credits.quote(parsed.data.total_days);
    const balance = await credits.balance(userId);

    return reply.code(200).send({
      /*
       * `null` = 一版价目表都没发布，本次生成不计费。键恒存在 ——
       * 省略它会让前端读到 undefined 并渲染出「预计 undefined CR」。
       */
      price_version: quote.priceVersion,
      typical_cr: quote.typicalCr,
      ceiling_cr: quote.ceilingCr,
      hold_cr: quote.holdCr,
      typical_cny: quote.typicalCny,
      ceiling_cny: quote.ceilingCny,
      balance_cr: balance.balanceCr,
      held_cr: balance.heldCr,
      /*
       * 结论由服务端给。前端拿它禁用按钮，不做任何比较 ——
       * 见文件头「按钮说够、提交被拒」。
       */
      sufficient: balance.balanceCr >= quote.holdCr,
    });
  });

  app.get('/api/v1/credits/ledger', async (request, reply) => {
    const userId = await requireRegistered(request, reply);
    if (userId === null) return reply;

    const query = LedgerQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(
        request,
        reply,
        'REQ_SCHEMA_INVALID',
        query.error.issues[0]?.path.join('.') ?? 'query',
      );
    }

    const entries = await credits.history({
      userId,
      limit: query.data.limit,
      ...(query.data.before === undefined ? {} : { before: query.data.before }),
    });

    return reply.code(200).send({
      items: entries.map((entry) => ({
        entry_id: entry.entryId,
        kind: entry.kind,
        /* 有符号：进账为正、消费为负。前端据符号决定颜色与前缀 */
        amount_cr: entry.amountCr,
        balance_after_cr: entry.balanceAfterCr,
        ref_type: entry.refType,
        ref_id: entry.refId,
        created_at: entry.createdAt,
      })),
      /*
       * `metadata` 刻意不返回：它装的是逐项 SKU 明细，含供应商模型名与
       * 我们的单价，属于运营数据。用户要的是「这一笔花了多少」，
       * 而那已经在 `amount_cr` 里。
       */
      next_cursor: entries.length < query.data.limit ? null : (entries.at(-1)?.createdAt ?? null),
    });
  });
}
