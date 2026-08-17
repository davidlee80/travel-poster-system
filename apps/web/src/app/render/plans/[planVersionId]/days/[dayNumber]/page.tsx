import { notFound } from 'next/navigation';
import { TRAVEL_PLAN_FIXTURES, makeTravelPlanFixture } from '@tps/schemas';
import { buildDailyPoster, parseRenderVariant } from '@tps/presentation';
import { isFixtureVersion, loadDailyViewModel } from '@/lib/presentation-source';
import { TravelInfographic } from '@/templates/travel-infographic-v1';
import { RenderReadyProbe } from '@/components/RenderReadyProbe';

/**
 * 内部渲染路由（TP-1-07，设计稿 17.1）。
 *
 *   /render/plans/{plan_version_id}/days/{day_number}
 *
 * 访问控制由 middleware.ts 完成（HMAC 令牌 + 网络层）。本页面**不读取任何
 * 身份 Cookie** —— 渲染页面不带用户会话，因此不存在会话泄漏面（17.1）。
 *
 * ## 两条数据来源，按版本 ID 的形态区分（P3）
 *
 *   `fixture-N`  → 由 fixture 现算 ViewModel（视觉基线用，需要确定性输入）
 *   其余         → 读 `plan_presentations.view_model`（真实数据，含素材 URL）
 *
 * 真实路径**不重算 ViewModel**：12.3 明确 `*_compact` 等派生字段在
 * `BUILDING_PRESENTATION` 阶段一次性生成并落库，渲染阶段不再调用任何服务。
 * 在这里重算会让渲染产物与库里的展示数据可能不一致 ——
 * 而 17.3 的溢出重渲染正是按库里那份做的判断。
 */

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly planVersionId: string; readonly dayNumber: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** fixture 选择：`fixture-14` 形态的版本 ID 指定天数，其余默认 7 天 */
function fixtureFor(planVersionId: string) {
  const match = /^fixture-(\d+)$/.exec(planVersionId);
  if (match?.[1] !== undefined) {
    const days = Math.min(14, Math.max(1, Number(match[1])));
    return makeTravelPlanFixture({ totalDays: days, planVersionId });
  }
  return TRAVEL_PLAN_FIXTURES.sevenDays();
}

async function loadViewModel(planVersionId: string, day: number) {
  if (isFixtureVersion(planVersionId)) {
    const plan = fixtureFor(planVersionId);
    if (!plan.days.some((d) => d.day_number === day)) return null;
    return buildDailyPoster({ plan, dayNumber: day }).viewModel;
  }

  // 契约校验在 `loadDailyViewModel` 里做（旧契约的行返回 null → 404）
  return loadDailyViewModel(planVersionId, day);
}

export default async function RenderDailyPosterPage({ params, searchParams }: PageProps) {
  const { planVersionId, dayNumber } = await params;
  const query = await searchParams;

  const day = Number(dayNumber);
  if (!Number.isInteger(day) || day < 1) notFound();

  const variant = parseRenderVariant(query);
  const viewModel = await loadViewModel(planVersionId, day);
  if (viewModel === null) notFound();

  return (
    <>
      <TravelInfographic
        viewModel={viewModel}
        compact={variant.compact}
        hideBelowPriority={variant.hideBelowPriority}
        variant={variant.layout}
      />
      <RenderReadyProbe />
    </>
  );
}
