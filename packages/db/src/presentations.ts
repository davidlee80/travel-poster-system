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
  /**
   * 样式模板。缺省取**最近落库的那一套**（R-85）。
   *
   * 缺省是有意的：用户请求「看我的计划」时不一定指定模板。但缺省必须有
   * 确定的选法，否则同一个页面两次刷新可能长得不一样。
   */
  readonly templateId?: string;
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
    /**
     * 样式模板。缺省取**最近落库的那一套**（R-85）。
     *
     * 一个 `plan_version_id` 下可以共存多套模板的展示数据
     * （`plan_presentations_uk` 包含 `template_id`）。不给这个参数时必须
     * 有确定的选法，否则同一次导出的 PNG 与 PDF 可能取到不同模板 ——
     * 而两者都会被判为成功。
     *
     * 返回值的 `templateId` 会告诉调用方实际取到的是哪一套。
     */
    readonly templateId?: string;
  }): Promise<PresentationDetail | null>;
  /**
   * 该版本已落库的每日页天号，升序（TP-4-12）。
   *
   * 导出的 `ALL_DAYS` 需要它：`exports.day_numbers` 对非 SINGLE_DAY 恒为 null
   * （`exports_day_numbers_check` 强制），因此「有哪几天」只能来自
   * `plan_presentations`。用它而不是 `travel_plan_versions.total_days`：
   * 真正能渲染的是**落了 ViewModel 的那些天**，而两者在编排失败时会不一致 ——
   * 按 total_days 渲染会对不存在的页面发请求，得到 404 与一批失败天号。
   *
   * **`templateId` 是必填的**（R-85）。不过滤模板的后果是两套模板共存时
   * 14 天变 28 行，于是导出渲染 28 页 —— 时长翻倍、按页计费翻倍，
   * 而任务状态是 COMPLETED。导出行自带 `template_id`，因此调用方手上一定
   * 有这个值；做成可选只会让下一个调用方漏传而不报错。
   */
  listDayNumbers(planVersionId: string, templateId: string): Promise<readonly number[]>;

  /** TP-3-15：重复解析不产生重复绑定 */
  saveBindings(inputs: readonly SaveBindingInput[]): Promise<void>;

  /**
   * 连素材表一起取出某个版本绑定的素材及其**当前**状态。
   *
   * **不得用于渲染，也不得用于回填 ViewModel（R-83）。**
   *
   * 它与展示路径是两种不同的时间语义：
   *
   * ```text
   * plan_presentations.view_model   快照  —— 当时那张图的 URL，19.3 永久保存
   * listBindings（本方法）        实时  —— JOIN assets 取 a.storage_url
   * ```
   *
   * 用它渲染的后果是同一份计划两次打开可能长得不一样 —— 而「历史计划回看
   * 看到的就是当时那份」正是 ViewModel 快照存在的全部理由（也是素材 URL 不能用
   * 预签名、`assets` 不物理删除的理由）。
   *
   * 当前**没有生产调用方**：ViewModel 由 `resolve-assets.ts` 直接从内存里的解析
   * 结果构建，不重读数据库。保留它是因为它回答一个展示路径回答不了的运维问题：
   * 「这个版本绑了哪些素材，它们现在是什么状态（是不是被下架了、授权到期了）」。
   *
   * `templateId` 缺省时返回该版本**全部模板**的绑定（R-85）。这对上面那个
   * 运维问题是对的 —— 你想知道的是整个版本用了哪些素材，而不是某一套模板的。
   * 但它意味着多模板后返回值里会有同一 `slot_id` 的多行，需要自己按模板分组。
   */
  listBindings(planVersionId: string, templateId?: string): Promise<readonly BindingRow[]>;
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

    async findPresentation({ planId, userId, pageType, dayNumber, planVersionId, templateId }) {
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
            AND ($6::text IS NULL OR pr.template_id = $6::text)
            AND v.status IN ('READY', 'REPAIRED')
            AND CASE WHEN $5::uuid IS NULL
                     THEN pr.plan_version_id = p.current_version_id
                     ELSE pr.plan_version_id = $5::uuid
                END
          ORDER BY pr.created_at DESC, pr.template_id
          LIMIT 1`,
        [planId, userId, pageType, dayNumber ?? null, planVersionId ?? null, templateId ?? null],
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

    async findPresentationByVersion({ planVersionId, pageType, dayNumber, templateId }) {
      /*
       * 同样拦住 REJECTED 版本：渲染一份未通过校验的草稿会产出 PNG/PDF，
       * 而那些产物一旦落到对象存储就可能被分享出去（验收标准 15）。
       *
       * 缺 `templateId` 时，`ORDER BY pr.created_at DESC, pr.template_id` 是
       * 确定性的全部来源（R-85）。**`template_id` 那一段不能省**：
       * `created_at` 默认 NOW()，而 PostgreSQL 的 NOW() 是**事务级**的，
       * `savePresentations` 又是单事务批量写入 —— 同一批落库的多套模板
       * created_at 必然完全相同。只按 created_at 排序等于没排，
       * 而 `LIMIT 1` 会退回物理顺序。
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
            AND ($4::text IS NULL OR pr.template_id = $4::text)
            AND v.status IN ('READY', 'REPAIRED')
          ORDER BY pr.created_at DESC, pr.template_id
          LIMIT 1`,
        [planVersionId, pageType, dayNumber ?? null, templateId ?? null],
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

    async listDayNumbers(planVersionId, templateId) {
      const { rows } = await pool.query<{ day_number: number }>(
        `SELECT day_number FROM plan_presentations
          WHERE plan_version_id = $1 AND template_id = $2
            AND page_type = 'DAILY_POSTER' AND day_number IS NOT NULL
          ORDER BY day_number`,
        [planVersionId, templateId],
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

    async listBindings(planVersionId, templateId) {
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
            AND ($2::text IS NULL OR b.template_id = $2::text)
          ORDER BY b.day_number NULLS FIRST, b.slot_id, b.template_id`,
        [planVersionId, templateId ?? null],
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
