import { notFound } from 'next/navigation';
import { TRAVEL_PLAN_FIXTURES, TEMPLATE_ID_VALUES, makeTravelPlanFixture } from '@tps/schemas';
import type { TemplateId } from '@tps/schemas';
import { buildFullPlan, type FullPlanViewModel } from '@tps/presentation';
import { isFixtureVersion, loadFullPlanViewModel } from '@/lib/presentation-source';
import { templateComponent } from '@/templates/registry';
import { RenderReadyProbe } from '@/components/RenderReadyProbe';

/**
 * 完整计划页的内部渲染路由（TP-1-06/07，设计稿 17.1、3.3.1）。
 *
 *   /render/plans/{plan_version_id}/full
 *
 * 与单日路由同样受 middleware 的 HMAC 令牌保护，且令牌的 pageKey 必须是
 * `full` —— 单日令牌无法访问本页（否则一个「第 1 天」的令牌就能取到全部内容）。
 */

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly planVersionId: string }>;
  /*
   * 本路由原先没有 `searchParams`（它不读变体参数 —— 全览页不参与 17.3 的
   * 溢出重渲）。R-85 加它是为了读 `?template=`。
   */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function fixtureFor(planVersionId: string) {
  const match = /^fixture-(\d+)$/.exec(planVersionId);
  if (match?.[1] !== undefined) {
    const days = Math.min(14, Math.max(1, Number(match[1])));
    return makeTravelPlanFixture({ totalDays: days, planVersionId });
  }
  return TRAVEL_PLAN_FIXTURES.sevenDays();
}

/**
 * 两条来源，与单日路由同一处理（见那里的说明）。
 *
 * 完整页的 ViewModel 没有 Zod 契约（`FullPlanViewModel` 是 TS 接口 ——
 * 它不跨进程，由 `@tps/presentation` 独占产出）。因此这里只做形状探测：
 * 缺 `days` 数组就当作旧契约，返回 null 让路由 404。
 */
async function loadViewModel(
  planVersionId: string,
  templateId: string,
): Promise<FullPlanViewModel | null> {
  if (isFixtureVersion(planVersionId)) {
    const plan = fixtureFor(planVersionId);
    if (plan.days.length === 0) return null;
    return buildFullPlan({ plan, templateId: templateId as TemplateId }).viewModel;
  }

  const stored = (await loadFullPlanViewModel(
    planVersionId,
    templateId,
  )) as FullPlanViewModel | null;
  if (stored === null || !Array.isArray(stored.days) || stored.days.length === 0) {
    return null;
  }
  return stored;
}

/** 取查询参数的第一个值。与单日路由同一处理 */
function firstValue(query: Record<string, string | string[] | undefined>, key: string) {
  const raw = query[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function RenderFullPlanPage({ params, searchParams }: PageProps) {
  const { planVersionId } = await params;
  const query = await searchParams;

  const requested = firstValue(query, 'template') ?? TEMPLATE_ID_VALUES[0];
  const viewModel = await loadViewModel(planVersionId, requested);
  if (viewModel === null) notFound();

  /*
   * 与单日路由同一道理：组件按取回的 ViewModel 选，不按 URL 参数选。
   */
  const Template = templateComponent(viewModel.template_id, 'FULL_PLAN');
  if (Template === null) notFound();

  return (
    <>
      <Template viewModel={viewModel} />
      <RenderReadyProbe />
    </>
  );
}
