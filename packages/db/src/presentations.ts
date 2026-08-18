import type { Pool, PoolClient } from 'pg';

/**
 * 展示数据与素材绑定的仓储（TP-3-15、TP-3-16，设计稿 13.4、十五章）。
 *
 * 13.0 的归属约束在这里同样适用：读路径**必须**带 `user_id` 谓词，
 * 他人计划返回 `null` 由调用方映射为 404（不是 403，避免枚举计划 ID）。
 */

export type PageTypeValue = 'DAILY_POSTER' | 'FULL_PLAN';
export type ValidationStatusValue = 'VALID' | 'DEGRADED' | 'INVALID';

export interface SavePresentationInput {
  readonly planId: string;
  readonly planVersionId: string;
  readonly templateId: string;
  readonly pageType: PageTypeValue;
  /** `FULL_PLAN` 必须为 null（数据库有 CHECK 约束） */
  readonly dayNumber: number | null;
  readonly viewModel: unknown;
  readonly validationStatus: ValidationStatusValue;
}

export interface SaveBindingInput {
  readonly planId: string;
  readonly planVersionId: string;
  readonly dayNumber: number | null;
  readonly templateId: string;
  readonly slotId: string;
  readonly role: string;
  readonly assetId: string;
  readonly resolutionStrategy: string;
  /** 10.1 的 final_score 或 19.4 的 1.0 */
  readonly resolutionScore: number;
}

export interface PresentationDetail {
  readonly planVersionId: string;
  readonly templateId: string;
  readonly pageType: PageTypeValue;
  readonly dayNumber: number | null;
  readonly validationStatus: ValidationStatusValue;
  readonly viewModel: unknown;
}

export interface FindPresentationInput {
  readonly planId: string;
  readonly userId: string;
  readonly pageType: PageTypeValue;
  /** `DAILY_POSTER` 时必填 */
  readonly dayNumber?: number;
  /** 缺省时取计划的当前版本（13.4「默认返回最新的有效版本」） */
  readonly planVersionId?: string;
}

export interface BindingRow {
  readonly slotId: string;
  readonly role: string;
  readonly dayNumber: number | null;
  readonly assetId: string;
  readonly resolutionStrategy: string | null;
  readonly resolutionScore: number | null;
  readonly storageUrl: string;
  readonly thumbnailUrl: string | null;
  readonly sourceType: string;
  readonly representationType: string;
  readonly assetType: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface PresentationsRepository {
  /** N+1 页一次事务写入（重复编排走 upsert，见 `plan_presentations_uk`） */
  savePresentations(inputs: readonly SavePresentationInput[]): Promise<void>;
  findPresentation(input: FindPresentationInput): Promise<PresentationDetail | null>;

  /**
   * 按版本直取（供 17.1 的内部渲染路由）。
   *
   * **没有 `userId` 参数** —— 这是 13.0 归属约束的第二个例外
   * （第一个是 `findJobContext`）。理由：渲染路由**刻意不读任何身份 Cookie**
   * （17.1：渲染页面不带用户会话，因此不存在会话泄漏面），
   * 它的访问控制是绑定了 `plan_version_id` 的 HMAC 令牌 + 网络隔离。
   *
   * 在这里加 `user_id` 谓词需要渲染器先知道计划归谁 —— 而那意味着要么
   * 把 user_id 塞进渲染令牌（等于把归属信息发给一个不需要它的组件），
   * 要么让渲染器带上用户会话（那才是真正的泄漏面）。
   */
  findPresentationByVersion(input: {
    readonly planVersionId: string;
    readonly pageType: PageTypeValue;
    readonly dayNumber?: number;
  }): Promise<PresentationDetail | null>;
  /**
   * 该版本已落库的每日页天号，升序（TP-4-12）。
   *
   * 导出的 `ALL_DAYS` 需要它：`exports.day_numbers` 对非 SINGLE_DAY 恒为 null
   * （`exports_day_numbers_check` 强制），因此「有哪几天」只能来自
   * `plan_presentations`。用它而不是 `travel_plan_versions.total_days`：
   * 真正能渲染的是**落了 ViewModel 的那些天**，而两者在编排失败时会不一致 ——
   * 按 total_days 渲染会对不存在的页面发请求，得到 404 与一批失败天号。
   */
  listDayNumbers(planVersionId: string): Promise<readonly number[]>;

  /** TP-3-15：重复解析不产生重复绑定 */
  saveBindings(inputs: readonly SaveBindingInput[]): Promise<void>;
  /** 渲染与回填 ViewModel 用：连素材表一起取出展示所需字段 */
  listBindings(planVersionId: string): Promise<readonly BindingRow[]>;
}

export function createPresentationsRepository(pool: Pool): PresentationsRepository {
  return {
    async savePresentations(inputs) {
      if (inputs.length === 0) return;

      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const input of inputs) {
          /*
           * upsert 而不是「先删后插」：13.4 会并发读这些行，
           * 删除与插入之间存在一个「这一天没有展示数据」的窗口，
           * 那期间的请求会拿到 404 —— 而计划其实是好的。
           *
           * 也不是 DO NOTHING：重跑编排的目的通常正是让新 ViewModel 生效
           * （比如素材补齐后重解析），DO NOTHING 会让重跑静默无效。
           */
          await client.query(
            `INSERT INTO plan_presentations (
               plan_id, plan_version_id, template_id, page_type, day_number,
               view_model, validation_status)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (plan_version_id, template_id, page_type, COALESCE(day_number, -1))
             DO UPDATE SET view_model = EXCLUDED.view_model,
                           validation_status = EXCLUDED.validation_status`,
            [
              input.planId,
              input.planVersionId,
              input.templateId,
              input.pageType,
              input.dayNumber,
              JSON.stringify(input.viewModel),
              input.validationStatus,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async findPresentation({ planId, userId, pageType, dayNumber, planVersionId }) {
      /*
       * `v.status IN ('READY','REPAIRED')`：13.4 明确 REJECTED 版本一律 404
       * （验收标准 15）。带 `?plan_version_id=` 指定某个 REJECTED 版本时
       * 也走这条谓词 —— 否则「知道版本 ID 就能看到未通过校验的草稿」。
       *
       * 版本缺省时取 `p.current_version_id`，即 13.4 的「最新的有效版本」：
       * 触发器保证它永远不指向 REJECTED 版本。
       */
      const { rows } = await pool.query<{
        plan_version_id: string;
        template_id: string;
        page_type: PageTypeValue;
        day_number: number | null;
        validation_status: ValidationStatusValue;
        view_model: unknown;
      }>(
        `SELECT pr.plan_version_id, pr.template_id, pr.page_type, pr.day_number,
                pr.validation_status, pr.view_model
           FROM plan_presentations pr
           JOIN travel_plans p ON p.id = pr.plan_id
           JOIN travel_plan_versions v ON v.id = pr.plan_version_id
          WHERE pr.plan_id = $1
            AND p.user_id = $2
            AND pr.page_type = $3
            AND ($4::int IS NULL OR pr.day_number = $4::int)
            AND v.status IN ('READY', 'REPAIRED')
            AND CASE WHEN $5::uuid IS NULL
                     THEN pr.plan_version_id = p.current_version_id
                     ELSE pr.plan_version_id = $5::uuid
                END
          ORDER BY pr.created_at DESC
          LIMIT 1`,
        [planId, userId, pageType, dayNumber ?? null, planVersionId ?? null],
      );

      const row = rows[0];
      if (row === undefined) return null;

      return {
        planVersionId: row.plan_version_id,
        templateId: row.template_id,
        pageType: row.page_type,
        dayNumber: row.day_number,
        validationStatus: row.validation_status,
        viewModel: row.view_model,
      };
    },

    async findPresentationByVersion({ planVersionId, pageType, dayNumber }) {
      /*
       * 同样拦住 REJECTED 版本：渲染一份未通过校验的草稿会产出 PNG/PDF，
       * 而那些产物一旦落到对象存储就可能被分享出去（验收标准 15）。
       */
      const { rows } = await pool.query<{
        plan_version_id: string;
        template_id: string;
        page_type: PageTypeValue;
        day_number: number | null;
        validation_status: ValidationStatusValue;
        view_model: unknown;
      }>(
        `SELECT pr.plan_version_id, pr.template_id, pr.page_type, pr.day_number,
                pr.validation_status, pr.view_model
           FROM plan_presentations pr
           JOIN travel_plan_versions v ON v.id = pr.plan_version_id
          WHERE pr.plan_version_id = $1
            AND pr.page_type = $2
            AND ($3::int IS NULL OR pr.day_number = $3::int)
            AND v.status IN ('READY', 'REPAIRED')
          LIMIT 1`,
        [planVersionId, pageType, dayNumber ?? null],
      );

      const row = rows[0];
      if (row === undefined) return null;

      return {
        planVersionId: row.plan_version_id,
        templateId: row.template_id,
        pageType: row.page_type,
        dayNumber: row.day_number,
        validationStatus: row.validation_status,
        viewModel: row.view_model,
      };
    },

    async listDayNumbers(planVersionId) {
      const { rows } = await pool.query<{ day_number: number }>(
        `SELECT day_number FROM plan_presentations
          WHERE plan_version_id = $1 AND page_type = 'DAILY_POSTER' AND day_number IS NOT NULL
          ORDER BY day_number`,
        [planVersionId],
      );
      return rows.map((row) => row.day_number);
    },

    async saveBindings(inputs) {
      if (inputs.length === 0) return;

      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const input of inputs) {
          await client.query(
            `INSERT INTO plan_asset_bindings (
               plan_id, plan_version_id, day_number, template_id, slot_id, role,
               asset_id, resolution_strategy, resolution_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (plan_version_id, template_id, slot_id)
             DO UPDATE SET asset_id = EXCLUDED.asset_id,
                           resolution_strategy = EXCLUDED.resolution_strategy,
                           resolution_score = EXCLUDED.resolution_score`,
            [
              input.planId,
              input.planVersionId,
              input.dayNumber,
              input.templateId,
              input.slotId,
              input.role,
              input.assetId,
              input.resolutionStrategy,
              input.resolutionScore,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listBindings(planVersionId) {
      const { rows } = await pool.query<{
        slot_id: string;
        role: string;
        day_number: number | null;
        asset_id: string;
        resolution_strategy: string | null;
        resolution_score: string | null;
        storage_url: string;
        thumbnail_url: string | null;
        source_type: string;
        representation_type: string;
        asset_type: string;
        width: number | null;
        height: number | null;
      }>(
        `SELECT b.slot_id, b.role, b.day_number, b.asset_id,
                b.resolution_strategy, b.resolution_score,
                a.storage_url, a.thumbnail_url, a.source_type,
                a.representation_type, a.asset_type, a.width, a.height
           FROM plan_asset_bindings b
           JOIN assets a ON a.id = b.asset_id
          WHERE b.plan_version_id = $1
          ORDER BY b.day_number NULLS FIRST, b.slot_id`,
        [planVersionId],
      );

      return rows.map((row) => ({
        slotId: row.slot_id,
        role: row.role,
        dayNumber: row.day_number,
        assetId: row.asset_id,
        resolutionStrategy: row.resolution_strategy,
        // NUMERIC 经 pg 驱动是字符串（精度考虑），这里转回数值
        resolutionScore: row.resolution_score === null ? null : Number(row.resolution_score),
        storageUrl: row.storage_url,
        thumbnailUrl: row.thumbnail_url,
        sourceType: row.source_type,
        representationType: row.representation_type,
        assetType: row.asset_type,
        width: row.width,
        height: row.height,
      }));
    },
  };
}
