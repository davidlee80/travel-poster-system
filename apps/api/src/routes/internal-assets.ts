import { MAP_HEIGHT, MAP_WIDTH, renderSchematicMap } from '@tps/assets';
import { MapStyleSchema, RouteNodeSchema } from '@tps/schemas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeInternal, type InternalAuthDeps } from './internal-auth.js';

/**
 * 素材服务的内部端点（设计稿 14.2；14.1 见 `internal-resolve.ts`）。
 *
 * ## R-28：这些端点是**契约的宿主**，不是主路径
 *
 * 14.1 / 14.2 被写成「内部 API」，而 22.2 的结构决定又把素材服务
 * **合并进 generation-worker**（「V1 规模下三者串行且共享上下文，
 * 拆成三个服务只增加队列跳数与故障面」）。两条放在一起意味着：
 * Worker 要通过 HTTP 调用自己进程里的函数。那样做要额外承担一次序列化、
 * 一次网络往返、一套超时与重试，换来的只是「看起来像微服务」。
 *
 * 因此：
 *   - **主路径直接调用 `@tps/assets` 的纯函数**（见 worker 的 resolvers/）；
 *   - 这两个端点是同一批函数的薄封装，用途是（a）冻结 14.1/14.2 的对外
 *     契约并可被契约测试覆盖，（b）将来把素材服务拆出去时的现成接缝，
 *     （c）运维排查时能单独打一次渲染。
 *
 * 认证见 `internal-auth.ts`（共享密钥）。
 */

export type InternalAssetRoutesDeps = InternalAuthDeps;

const RenderSchematicBodySchema = z.object({
  style: MapStyleSchema,
  /** 上限 30：一天最多 6 条行程（3.1.1 的节奏上限），30 给足冗余又挡住滥用 */
  nodes: z.array(RouteNodeSchema).max(30),
});

export function registerInternalAssetRoutes(
  app: FastifyInstance,
  deps: InternalAssetRoutesDeps,
): void {
  /**
   * 14.2 生成路线 SVG。
   *
   * 纯渲染：不落库、不上传对象存储。缓存与持久化属于解析编排
   * （19.4 的 `CACHE_HIT` 判定发生在 resolver 里），端点只回答
   * 「这组节点画出来是什么样」。
   */
  app.post('/internal/v1/maps/render-schematic', async (request, reply) => {
    if (!authorizeInternal(request, reply, deps.internalApiKey)) return reply;

    const parsed = RenderSchematicBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'ASSET_REQUEST_INVALID',
          message: '请求体不符合 14.2 契约',
          field: parsed.error.issues[0]?.path.join('.') ?? null,
        },
      });
    }

    const result = renderSchematicMap({
      nodes: parsed.data.nodes,
      style: parsed.data.style,
    });

    if (result.kind === 'insufficient_nodes') {
      /*
       * 200 + `rendered: false` 而不是 4xx：节点不足 2 个是**正常的业务
       * 结果**（V-08 剔除越界坐标后就可能只剩一个点），调用方据此走 8.2 的
       * 文字降级。用 4xx 会让 resolver 把它当成错误重试，而重试的输入一样。
       */
      return reply.code(200).send({
        rendered: false,
        reason: 'INSUFFICIENT_NODES',
        valid_nodes: result.validNodes,
        min_nodes: 2,
      });
    }

    return reply.code(200).send({
      rendered: true,
      svg: result.map.svg,
      width: result.map.width,
      height: result.map.height,
      node_count: result.map.nodeCount,
      route_node_hash: result.map.routeNodeHash,
      map_style: result.map.style,
      viewbox: { width: MAP_WIDTH, height: MAP_HEIGHT },
    });
  });
}
