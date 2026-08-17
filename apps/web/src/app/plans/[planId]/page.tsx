'use client';

import { buildFullPlan } from '@tps/presentation';
import { TravelPlanSchema } from '@tps/schemas';
import { useEffect, useState } from 'react';

import { getPlan } from '@/lib/api-client';
import { TravelFullPlan } from '@/templates/travel-full-plan-v1';

/**
 * 用户可见的完整计划页（TP-2-17，设计稿 1.1「可浏览的完整计划页」）。
 *
 * ## 与 `/render/plans/{plan_version_id}/full` 的区别
 *
 * 那条是**内部渲染路由**：受 HMAC 令牌保护，供 render-worker 截图用，
 * 数据来自 fixture 或（P3 起）落库的 ViewModel。
 *
 * 这一条是给用户看的：走 13.3，因此**归属由服务端强制**（他人的计划返回
 * 404）。两条路由分开是必须的 —— 合成一条的话，要么内部路由需要用户会话
 * （render-worker 没有），要么用户页面要带 HMAC 令牌（那等于把签名密钥
 * 发给浏览器）。
 *
 * P2 是文字版（无图）。模板本身不依赖素材，缺图时走占位与文字降级。
 */

export const dynamic = 'force-dynamic';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly viewModel: ReturnType<typeof buildFullPlan>['viewModel'] };

export default function PlanPage({
  params,
}: {
  readonly params: Promise<{ readonly planId: string }>;
}): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { planId } = await params;
      const result = await getPlan(planId);
      if (cancelled) return;

      if (!result.ok) {
        setState({ kind: 'error', message: result.message });
        return;
      }

      /*
       * 用 schema 解析而不是直接断言类型。后端改了契约时，这里给出
       * 「计划数据格式不受支持」，而直接断言会在渲染中途抛
       * `undefined is not an object` —— 那时离根因已经很远，
       * 而且整页白屏。
       */
      const parsed = TravelPlanSchema.safeParse(result.data);
      if (!parsed.success) {
        setState({ kind: 'error', message: '计划数据格式不受支持，请刷新页面或联系支持。' });
        return;
      }

      setState({ kind: 'loaded', viewModel: buildFullPlan({ plan: parsed.data }).viewModel });
    })();

    return () => {
      cancelled = true;
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

  return <TravelFullPlan viewModel={state.viewModel} />;
}
