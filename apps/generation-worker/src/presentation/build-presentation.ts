import type { PresentationsRepository, SavePresentationInput } from '@tps/db';
import {
  assetRequirementEnvelope,
  buildDailyPoster,
  buildFullPlan,
  mergeRequirements,
  buildPresentationPlans,
  DAILY_CONTENT_LIMITS,
  EMPTY_ASSET_LOOKUP,
  type AssetLookup,
} from '@tps/presentation';
import type { PresentationValidation, ResolvedAsset, TravelPlan } from '@tps/schemas';
import type { Logger } from '@tps/shared';

import { resolveAssets, toAssetLookup, type ResolveAssetsDeps } from '../assets/resolve-assets.js';

/**
 * 展示编排与素材解析的落库（TP-3-03～TP-3-05、TP-3-15、TP-3-16）。
 *
 * 16.1 的两个阶段：
 * ```text
 * BUILDING_PRESENTATION   编排 N+1 页、生成槽位清单
 * RESOLVING_ASSETS        解析素材、写绑定、把 ViewModel 落库
 * ```
 *
 * ## 为什么 ViewModel 在素材解析**之后**才落库
 *
 * ViewModel 里含素材 URL（`hero_asset`、`*.image`、`route_map.svg_url`）。
 * 先落一份没有图的 ViewModel 再更新，会让 13.4 在两次写入之间返回
 * 一个「结构完整但全是占位」的页面 —— 而前端拿到 200 就会渲染，
 * 用户看到的是一个没有图的成品，然后页面莫名变了。
 *
 * 因此顺序是：编排 → 解析 → 一次性写入。BUILDING_PRESENTATION 阶段
 * 只推进状态与算槽位（纯计算，毫秒级），不写库。
 *
 * ## validation_status 的判定（十五章）
 *
 *   VALID     全槽位解析成功
 *   DEGRADED  存在 FALLBACK / SKIPPED 槽位但可渲染
 *   INVALID   必需槽位缺失，不可渲染
 */

export interface BuildPresentationDeps extends ResolveAssetsDeps {
  readonly presentations: PresentationsRepository;
  readonly logger: Logger;
}

export interface BuildPresentationResult {
  readonly pages: number;
  readonly validationStatus: PresentationValidation;
  readonly resolved: readonly ResolvedAsset[];
  readonly bindings: number;
  /** 因 `content_limits` 被裁掉的条目总数（21.3 的打点用） */
  readonly omitted: number;
  readonly budgetMismatch: boolean;
}

export async function buildAndSavePresentations(
  deps: BuildPresentationDeps,
  plan: TravelPlan,
): Promise<BuildPresentationResult> {
  // ── BUILDING_PRESENTATION：N+1 页与槽位清单（纯计算）──
  const plans = buildPresentationPlans({ plan });
  const merged = mergeRequirements(plans);
  if (merged.duplicates.length > 0) {
    /*
     * 槽位 ID 天然带 day_N 前缀，重复只可能来自 slots.ts 的缺陷。
     * 记 error 而不是抛错：解析仍能继续（去重后的清单是对的），
     * 而抛错会让用户因为一个展示层缺陷拿不到计划。
     */
    deps.logger.error(
      { stage: 'BUILDING_PRESENTATION' },
      `槽位 ID 重复 ${merged.duplicates.length} 个，已去重后继续`,
    );
  }

  const envelope = assetRequirementEnvelope({
    planId: plan.plan_id,
    planVersionId: plan.plan_version_id,
    templateId: 'travel_infographic_v1',
    requirements: merged.requirements,
  });

  // ── RESOLVING_ASSETS：解析 + 绑定 ──
  const resolution = await resolveAssets(deps, envelope);
  await deps.presentations.saveBindings(resolution.bindings);

  const lookup: AssetLookup =
    resolution.all.length === 0
      ? EMPTY_ASSET_LOOKUP
      : toAssetLookup(envelope.requirements, resolution.all);

  const validationStatus = validationStatusOf(resolution.response.status, resolution.all);

  const rows: SavePresentationInput[] = [];
  let omitted = 0;
  let budgetMismatch = false;

  for (const page of plans) {
    if (page.page_type === 'DAILY_POSTER' && page.day_number !== null) {
      const built = buildDailyPoster({
        plan,
        dayNumber: page.day_number,
        templateId: page.template_id,
        assets: lookup,
        limits: DAILY_CONTENT_LIMITS,
      });
      omitted += Object.values(built.omitted).reduce((acc, value) => acc + value, 0);
      budgetMismatch = budgetMismatch || built.budgetMismatch;

      rows.push({
        planId: plan.plan_id,
        planVersionId: plan.plan_version_id,
        templateId: page.template_id,
        pageType: 'DAILY_POSTER',
        dayNumber: page.day_number,
        viewModel: built.viewModel,
        validationStatus,
      });
      continue;
    }

    const full = buildFullPlan({ plan, templateId: page.template_id, assets: lookup });
    budgetMismatch = budgetMismatch || full.budgetMismatch;
    rows.push({
      planId: plan.plan_id,
      planVersionId: plan.plan_version_id,
      templateId: page.template_id,
      pageType: 'FULL_PLAN',
      dayNumber: null,
      viewModel: full.viewModel,
      validationStatus,
    });
  }

  await deps.presentations.savePresentations(rows);

  return {
    pages: rows.length,
    validationStatus,
    resolved: resolution.all,
    bindings: resolution.bindings.length,
    omitted,
    budgetMismatch,
  };
}

/** 十五章的三档 */
function validationStatusOf(
  responseStatus: 'COMPLETED' | 'PARTIAL',
  results: readonly ResolvedAsset[],
): PresentationValidation {
  // PARTIAL 意味着必需槽位 FAILED —— 不可渲染
  if (responseStatus === 'PARTIAL') return 'INVALID';

  const degraded = results.some(
    (result) => result.status === 'FALLBACK' || result.status === 'SKIPPED',
  );
  return degraded ? 'DEGRADED' : 'VALID';
}
