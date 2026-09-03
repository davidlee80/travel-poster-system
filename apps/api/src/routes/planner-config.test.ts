import type { PlannerConfigRepository } from '@tps/db';
import {
  PLANNER_FIELD_REQUIREMENTS,
  PLANNER_GENERATION_REQUIRED_FIELD_IDS,
} from '@tps/schemas';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerPlannerConfigRoutes } from './planner-config.js';

const config: PlannerConfigRepository = {
  getPublished: () =>
    Promise.resolve({
      version: 4,
      publishedAt: '2026-09-02T00:00:00.000Z',
      fields: {},
    }),
};

describe('GET /api/v1/planner/config', () => {
  it('把后台生成必填字段随发布配置一起下发给前端', async () => {
    const app = Fastify();
    registerPlannerConfigRoutes(app, { config });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/planner/config' });
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"planner-config-4-requirements-v2"');
      expect(response.json().generation_required_field_ids).toEqual(
        PLANNER_GENERATION_REQUIRED_FIELD_IDS,
      );
      expect(response.json().generation_required_field_ids).not.toContain('PV2-09-002');
      expect(response.json().field_requirements).toEqual(PLANNER_FIELD_REQUIREMENTS);
      expect(response.json().field_requirements).toHaveLength(76);
    } finally {
      await app.close();
    }
  });

  it('优先返回发布版本中的完整字段分类', async () => {
    const published = PLANNER_FIELD_REQUIREMENTS.map((requirement) =>
      requirement.field_id === 'PV2-06-001'
        ? {
            ...requirement,
            requirement_mode: 'BASE_REQUIRED' as const,
            blocking_scope: 'PLAN' as const,
            allow_clear: false,
          }
        : requirement,
    );
    const app = Fastify();
    registerPlannerConfigRoutes(app, {
      config: {
        getPublished: () =>
          Promise.resolve({
            version: 5,
            publishedAt: '2026-09-03T00:00:00.000Z',
            fields: {},
            fieldRequirements: published,
          }),
      },
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/planner/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json().field_requirements).toEqual(published);
    } finally {
      await app.close();
    }
  });
});
