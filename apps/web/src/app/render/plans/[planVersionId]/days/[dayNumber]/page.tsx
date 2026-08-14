import { notFound } from 'next/navigation';
import { TRAVEL_PLAN_FIXTURES, makeTravelPlanFixture } from '@tps/schemas';
import { buildDailyPoster } from '@tps/presentation';
import { TravelInfographic } from '@/templates/travel-infographic-v1';
import { RenderReadyProbe } from '@/components/RenderReadyProbe';
import { parseRenderVariant } from '@/lib/render-variant';

/**
 * 内部渲染路由（TP-1-07，设计稿 17.1）。
 *
 *   /render/plans/{plan_version_id}/days/{day_number}
 *
 * 访问控制由 middleware.ts 完成（HMAC 令牌 + 网络层）。本页面**不读取任何
 * 身份 Cookie** —— 渲染页面不带用户会话，因此不存在会话泄漏面（17.1）。
 *
 * ## P1 的数据来源是 fixture
 *
 * 真实数据来自 `plan_presentations.view_model`（P3 起）。P1 用 fixture 是
 * 有意的：设计稿第一阶段的目标是「先证明模板链路可行」，在引入 LLM 与
 * 数据库之前拿到确定性产物。fixture 由 `plan_version_id` 的形态选择天数，
 * 让视觉基线可以覆盖 1/7/14 天三档。
 */

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly planVersionId: string; readonly dayNumber: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** P1 fixture 选择：`fixture-14` 形态的版本 ID 指定天数，其余默认 7 天 */
function fixtureFor(planVersionId: string) {
  const match = /^fixture-(\d+)$/.exec(planVersionId);
  if (match?.[1] !== undefined) {
    const days = Math.min(14, Math.max(1, Number(match[1])));
    return makeTravelPlanFixture({ totalDays: days, planVersionId });
  }
  return TRAVEL_PLAN_FIXTURES.sevenDays();
}

export default async function RenderDailyPosterPage({ params, searchParams }: PageProps) {
  const { planVersionId, dayNumber } = await params;
  const query = await searchParams;

  const day = Number(dayNumber);
  if (!Number.isInteger(day) || day < 1) notFound();

  const plan = fixtureFor(planVersionId);
  if (!plan.days.some((d) => d.day_number === day)) notFound();

  const { viewModel } = buildDailyPoster({ plan, dayNumber: day });
  const variant = parseRenderVariant(query);

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
