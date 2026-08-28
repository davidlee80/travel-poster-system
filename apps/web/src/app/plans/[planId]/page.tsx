'use client';

import { buildFullPlan } from '@tps/presentation';
import { FullPlanViewModelSchema, TravelPlanSchema } from '@tps/schemas';
import type { FullPlanViewModelShape } from '@tps/schemas';
import { useEffect, useState } from 'react';

import { ExportPanel } from '@/components/ExportPanel';
import { getFullPresentation, getPlan } from '@/lib/api-client';
import { templateComponent } from '@/templates/registry';

/**
 * 用户可见的完整计划页（TP-2-17、TP-3-17，设计稿 1.1「可浏览的完整计划页」）。
 *
 * ## 与 `/render/plans/{plan_version_id}/full` 的区别
 *
 * 那条是**内部渲染路由**：受 HMAC 令牌保护，供 render-worker 截图用。
 * 这一条是给用户看的，因此**归属由服务端强制**（他人的计划返回 404）。
 * 两条路由分开是必须的 —— 合成一条的话，要么内部路由需要用户会话
 * （render-worker 没有），要么用户页面要带 HMAC 令牌（那等于把签名密钥
 * 发给浏览器）。
 *
 * ## 两个数据源，优先带图的那个
 *
 * ```text
 * 13.4  落库的 ViewModel —— Hero、景点/美食配图、路线图 SVG 都已绑定
 *       这是设计稿 1.1「信息图」的数据源
 * 13.3  plan_json —— 纯行程数据，**不含素材**。现场构建出的是无图版本
 * ```
 *
 * 页面优先读 13.4；编排还没跑完时它返回 404（**正常时序** —— 16.1 的
 * `BUILDING_PRESENTATION` 在 `SAVING_PLAN` 之后），此时退回 13.3 的文字版
 * 并继续轮询。这正好实现 21.2 措施一的分段交付：
 *
 * ```text
 * T1（计划可读）  文字版立刻可看，用户不必等素材
 * T2（页面可看）  轮询到 13.4 就绪后自动升级为带图版本
 * ```
 *
 * 在 P5 之前这个页面只读 13.3 —— 于是 P3 的素材绑定与 P4 的 AI 配图
 * 只存在于数据库与内部渲染路由里，用户看到的每张图都是占位。
 */

export const dynamic = 'force-dynamic';

/**
 * 升级轮询的间隔与上限。
 *
 * 21.2 的 T2 目标是 110 秒（≤7 天档），8～14 天档更长。上限取 180 秒是为了
 * 覆盖长天数档之后还有余量 —— 超时后停在文字版并给出提示，而不是无限转圈。
 */
const UPGRADE_POLL_MS = 3_000;
const UPGRADE_TIMEOUT_MS = 180_000;

type Source = 'presentation' | 'plan';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'loaded';
      readonly viewModel: FullPlanViewModelShape;
      readonly source: Source;
      /** 13.4 的 `validation_status`。DEGRADED 时提示部分配图不可用 */
      readonly validationStatus: string | null;
      /** 仍在等 13.4 就绪（只在 source='plan' 时为真） */
      readonly upgrading: boolean;
    };

export default function PlanPage({
  params,
}: {
  readonly params: Promise<{ readonly planId: string }>;
}): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [planId, setPlanId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 尝试 13.4。成功返回 ViewModel，未就绪返回 null，硬失败抛出消息 */
    async function tryPresentation(
      id: string,
    ): Promise<{ viewModel: FullPlanViewModelShape; validationStatus: string } | null> {
      const result = await getFullPresentation(id);
      if (!result.ok) {
        /*
         * 404 是「编排还没跑完」或「计划不存在/不属于你」—— 13.4 刻意用一个
         * 404 覆盖五种情况（见路由注释）。因此这里不能把它当错误，
         * 要退回 13.3：那一条能区分「计划不存在」（同样 404）与「可读」。
         */
        if (result.status === 404) return null;
        throw new Error(result.message);
      }

      const parsed = FullPlanViewModelSchema.safeParse(result.data.view_model);
      if (!parsed.success) {
        /*
         * 落库的 ViewModel 解析失败说明模板契约与库里的数据分了叉
         * （改了 schema 但没重跑编排）。退回文字版而不是报错 ——
         * 用户的行程本身是好的，不该因为配图数据的格式问题看不到它。
         */
        return null;
      }
      return { viewModel: parsed.data, validationStatus: result.data.validation_status };
    }

    /** 13.3 的文字版。这一条失败才是真的失败 */
    async function loadTextVersion(id: string): Promise<FullPlanViewModelShape> {
      const result = await getPlan(id);
      if (!result.ok) throw new Error(result.message);

      /*
       * 用 schema 解析而不是直接断言类型。后端改了契约时，这里给出
       * 「计划数据格式不受支持」，而直接断言会在渲染中途抛
       * `undefined is not an object` —— 那时离根因已经很远，而且整页白屏。
       */
      const parsed = TravelPlanSchema.safeParse(result.data);
      if (!parsed.success) {
        throw new Error('计划数据格式不受支持，请刷新页面或联系支持。');
      }
      return buildFullPlan({ plan: parsed.data }).viewModel;
    }

    void (async () => {
      const { planId: id } = await params;
      if (cancelled) return;
      setPlanId(id);

      const startedAt = Date.now();

      try {
        const presentation = await tryPresentation(id);
        if (cancelled) return;

        if (presentation !== null) {
          setState({
            kind: 'loaded',
            viewModel: presentation.viewModel,
            source: 'presentation',
            validationStatus: presentation.validationStatus,
            upgrading: false,
          });
          return;
        }

        // 13.4 未就绪 —— 先给文字版（T1），再轮询升级（T2）
        const textVersion = await loadTextVersion(id);
        if (cancelled) return;
        setState({
          kind: 'loaded',
          viewModel: textVersion,
          source: 'plan',
          validationStatus: null,
          upgrading: true,
        });

        const poll = async (): Promise<void> => {
          if (cancelled) return;

          if (Date.now() - startedAt > UPGRADE_TIMEOUT_MS) {
            /*
             * 超时不是错误：文字版计划完整可读，只是配图没等到。
             * 把它变成错误会让用户失去一份本来可用的行程。
             */
            setState((current) =>
              current.kind === 'loaded' ? { ...current, upgrading: false } : current,
            );
            return;
          }

          const upgraded = await tryPresentation(id).catch(() => null);
          if (cancelled) return;

          if (upgraded !== null) {
            setState({
              kind: 'loaded',
              viewModel: upgraded.viewModel,
              source: 'presentation',
              validationStatus: upgraded.validationStatus,
              upgrading: false,
            });
            return;
          }
          timer = setTimeout(() => void poll(), UPGRADE_POLL_MS);
        };

        timer = setTimeout(() => void poll(), UPGRADE_POLL_MS);
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : '载入计划失败，请稍后重试。',
        });
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [params]);

  if (state.kind === 'loading') {
    return (
      <main className="plan-page plan-page--pending">
        <p role="status">正在载入计划…</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="plan-page plan-page--pending">
        <p role="alert">{state.message}</p>
        <p>
          <a href="/">返回首页</a>
        </p>
      </main>
    );
  }

  /*
   * 组件按 ViewModel 自带的 `template_id` 选（R-85）。本页不接收模板参数 ——
   * 用户看的就是这份计划生成时选的那一套。
   *
   * 未注册时不渲染而提示：那意味着库里的 `template_id` 不在当前枚举里
   * （比如套件被下线了而存量计划未迁移）。静默回退到默认套件会让用户
   * 看到一份与当初不同的产物，而那比一条提示更难发现。
   */
  const FullPlanTemplate = templateComponent(state.viewModel.template_id, 'FULL_PLAN');
  if (FullPlanTemplate === null) {
    return (
      <p className="plan-page__notice" role="alert">
        这份计划用的样式套件（{state.viewModel.template_id}）已不可用。
      </p>
    );
  }

  return (
    <>
      {state.upgrading ? (
        <p className="plan-page__notice" role="status">
          行程已生成，配图仍在准备中 —— 就绪后本页会自动更新。
        </p>
      ) : null}
      {/*
       * DEGRADED：存在降级槽位但页面可渲染（十五章）。提示出来是必要的 ——
       * 不提示的话用户只会看到几个占位块而不知道原因（13.4 返回这个字段
       * 正是为了让前端能说明）。
       */}
      {state.validationStatus === 'DEGRADED' ? (
        <p className="plan-page__notice" role="status">
          部分配图使用了默认样式。
        </p>
      ) : null}
      <FullPlanTemplate viewModel={state.viewModel} />
      {planId === null ? null : <ExportPanel planId={planId} viewModel={state.viewModel} />}
    </>
  );
}
