import type { PresentationsRepository } from '@tps/db';
import type { FastifyInstance } from 'fastify';

import { authorizeInternal, type InternalAuthDeps } from './internal-auth.js';

/**
 * 渲染路由的展示数据端点（TP-3-17，设计稿 17.1、13.4）。
 *
 *   GET /internal/v1/plan-versions/{plan_version_id}/presentations/full
 *   GET /internal/v1/plan-versions/{plan_version_id}/presentations/{day_number}
 *
 * ## 为什么需要一个「按版本取」的内部端点
 *
 * 13.4 是**用户端点**，按 `user_id` 过滤（13.0）。而渲染路由刻意不带用户
 * 会话（17.1：渲染页面不读任何身份 Cookie，因此没有会话泄漏面），
 * 它自己的访问控制是绑定 `plan_version_id` 的 HMAC 令牌 + 网络隔离。
 *
 * 让渲染路由去调 13.4 就得给它一个用户身份 —— 那正是 17.1 要避免的。
 * 让它直连数据库也不行：那等于把数据库凭据发给前端进程，
 * 而且 Next.js 的打包器不能处理 `pg` 与 `@node-rs/argon2` 的原生模块
 * （实测 webpack 直接编译失败）。
 *
 * 因此保留一个只按版本取数的内部端点，用共享密钥认证。
 * 它返回的是**已经落库的 ViewModel**，不含任何用户标识（12.x 的 ViewModel
 * 只有 `plan_id` / `plan_version_id` 与展示文案）。
 */

export interface InternalPresentationRoutesDeps extends InternalAuthDeps {
  readonly presentations: PresentationsRepository;
}

export function registerInternalPresentationRoutes(
  app: FastifyInstance,
  deps: InternalPresentationRoutesDeps,
): void {
  app.get<{ Params: { plan_version_id: string } }>(
    '/internal/v1/plan-versions/:plan_version_id/presentations/full',
    async (request, reply) => {
      if (!authorizeInternal(request, reply, deps.internalApiKey)) return reply;

      const detail = await deps.presentations.findPresentationByVersion({
        planVersionId: request.params.plan_version_id,
        pageType: 'FULL_PLAN',
      });
      if (detail === null) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

      return reply.code(200).send({
        plan_version_id: detail.planVersionId,
        template_id: detail.templateId,
        page_type: detail.pageType,
        day_number: detail.dayNumber,
        validation_status: detail.validationStatus,
        view_model: detail.viewModel,
      });
    },
  );

  app.get<{ Params: { plan_version_id: string; day_number: string } }>(
    '/internal/v1/plan-versions/:plan_version_id/presentations/:day_number',
    async (request, reply) => {
      if (!authorizeInternal(request, reply, deps.internalApiKey)) return reply;

      const day = Number(request.params.day_number);
      if (!Number.isInteger(day) || day < 1 || day > 14) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const detail = await deps.presentations.findPresentationByVersion({
        planVersionId: request.params.plan_version_id,
        pageType: 'DAILY_POSTER',
        dayNumber: day,
      });
      if (detail === null) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

      return reply.code(200).send({
        plan_version_id: detail.planVersionId,
        template_id: detail.templateId,
        page_type: detail.pageType,
        day_number: detail.dayNumber,
        validation_status: detail.validationStatus,
        view_model: detail.viewModel,
      });
    },
  );
}
