import { notFound } from 'next/navigation';
import { TRAVEL_PLAN_FIXTURES, TEMPLATE_ID_VALUES, makeTravelPlanFixture } from '@tps/schemas';
import type { TemplateId } from '@tps/schemas';
import { buildDailyPoster, parseRenderVariant } from '@tps/presentation';
import { isFixtureVersion, loadDailyViewModel } from '@/lib/presentation-source';
import { templateComponent } from '@/templates/registry';
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

async function loadViewModel(planVersionId: string, day: number, templateId: string) {
  if (isFixtureVersion(planVersionId)) {
    const plan = fixtureFor(planVersionId);
    if (!plan.days.some((d) => d.day_number === day)) return null;
    return buildDailyPoster({ plan, dayNumber: day, templateId: templateId as TemplateId })
      .viewModel;
  }

  // 契约校验在 `loadDailyViewModel` 里做（旧契约的行返回 null → 404）
  return loadDailyViewModel(planVersionId, day, templateId);
}

/** 取查询参数的第一个值。Next 的 searchParams 对重复参数给数组 */
function firstValue(query: Record<string, string | string[] | undefined>, key: string) {
  const raw = query[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function RenderDailyPosterPage({ params, searchParams }: PageProps) {
  const { planVersionId, dayNumber } = await params;
  const query = await searchParams;

  const day = Number(dayNumber);
  if (!Number.isInteger(day) || day < 1) notFound();

  const variant = parseRenderVariant(query);

  /*
   * 样式套件从 `?template=` 来（R-85）。缺省取第一套 —— 手工打开这个页面
   * 排查时不应当被迫拼参数；而生产路径上 run-export 总是会带它。
   */
  const requested = firstValue(query, 'template') ?? TEMPLATE_ID_VALUES[0];
  const viewModel = await loadViewModel(planVersionId, day, requested);
  if (viewModel === null) notFound();

  /*
   * 组件按**取回的 ViewModel** 选，而不是按 URL 参数选。
   *
   * 两者正常下相同，但用 ViewModel 里那个值能排除一种死角：
   * 取了 A 的数据却用 B 的组件渲。那种不一致不会报错，
   * 只会产出一张排版错乱的图 —— 而任务仍然 COMPLETED。
   */
  const Template = templateComponent(viewModel.template_id, 'DAILY_POSTER');
  if (Template === null) notFound();

  return (
    <>
      <Template
        viewModel={viewModel}
        compact={variant.compact}
        hideBelowPriority={variant.hideBelowPriority}
        variant={variant.layout}
      />
      <RenderReadyProbe />
    </>
  );
}
