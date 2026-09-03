import type { Pool } from 'pg';

export interface PlannerConfigOption {
  readonly key: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PublishedPlannerConfig {
  readonly version: number;
  readonly publishedAt: string;
  readonly fields: Readonly<Record<string, readonly PlannerConfigOption[]>>;
  /** JSONB is validated at the API boundary by @tps/schemas. */
  readonly fieldRequirements?: unknown;
}

export interface PlannerConfigRepository {
  getPublished(): Promise<PublishedPlannerConfig | null>;
}

interface OptionRow {
  readonly version: number;
  readonly published_at: Date;
  readonly field_key: string;
  readonly option_key: string;
  readonly label: string;
  readonly metadata: Record<string, unknown>;
  readonly field_requirements: unknown;
}

export function createPlannerConfigRepository(pool: Pool): PlannerConfigRepository {
  return {
    async getPublished() {
      const result = await pool.query<OptionRow>(
        `SELECT v.version, v.published_at, v.field_requirements,
                o.field_key, o.option_key, o.label, o.metadata
         FROM planner_config_versions v
         JOIN planner_config_options o ON o.version_id = v.id
         WHERE v.status = 'PUBLISHED' AND o.enabled = TRUE
         ORDER BY o.field_key, o.sort_order, o.option_key`,
      );
      const first = result.rows[0];
      if (first === undefined) return null;
      const fields: Record<string, PlannerConfigOption[]> = {};
      for (const row of result.rows) {
        (fields[row.field_key] ??= []).push({
          key: row.option_key,
          label: row.label,
          metadata: row.metadata,
        });
      }
      return {
        version: first.version,
        publishedAt: first.published_at.toISOString(),
        fields,
        fieldRequirements: first.field_requirements,
      };
    },
  };
}
