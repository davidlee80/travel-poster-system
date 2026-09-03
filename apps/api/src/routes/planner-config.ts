import type { FastifyInstance } from 'fastify';
import type { PlannerConfigRepository } from '@tps/db';
import {
  PLANNER_FIELD_REQUIREMENTS,
  PLANNER_GENERATION_REQUIRED_FIELD_IDS,
  PlannerFieldRequirementsSchema,
} from '@tps/schemas';

export interface PlannerConfigRoutesDeps {
  readonly config: PlannerConfigRepository;
}

export function registerPlannerConfigRoutes(
  app: FastifyInstance,
  deps: PlannerConfigRoutesDeps,
): void {
  app.get('/api/v1/planner/config', async (_request, reply) => {
    const config = await deps.config.getPublished();
    if (config === null) {
      return reply.code(503).send({
        error: {
          code: 'SYS_DEPENDENCY_UNAVAILABLE',
          message: '规划器配置尚未发布。',
          retryable: true,
        },
      });
    }
    reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    reply.header('etag', `"planner-config-${config.version}-requirements-v2"`);
    const parsedRequirements = PlannerFieldRequirementsSchema.safeParse(config.fieldRequirements);
    if (!parsedRequirements.success && config.fieldRequirements !== undefined) {
      app.log.warn(
        { version: config.version, issues: parsedRequirements.error.issues },
        'published planner field requirements are invalid; using shared baseline',
      );
    }
    const fieldRequirements = parsedRequirements.success
      ? parsedRequirements.data
      : PLANNER_FIELD_REQUIREMENTS;
    return reply.code(200).send({
      version: config.version,
      published_at: config.publishedAt,
      fields: config.fields,
      generation_required_field_ids: PLANNER_GENERATION_REQUIRED_FIELD_IDS,
      field_requirements: fieldRequirements,
    });
  });
}
