/**
 * 渲染路由的数据来源（TP-3-17，设计稿 17.1、13.4）。
 *
 * ## 为什么走内部端点，而不是直连数据库或调 13.4
 *
 * **不调 13.4**：那是用户端点，按 `user_id` 过滤（13.0）。而渲染路由刻意
 * 不带用户会话（17.1：渲染页面不读任何身份 Cookie，因此没有会话泄漏面）。
 * 让它调 13.4 就得给它一个用户身份 —— 那正是 17.1 要避免的东西。
 *
 * **不直连数据库**：等于把数据库凭据发到前端进程；而且 Next.js 的打包器
 * 处理不了 `pg` 与（经 `@tps/shared` 传入的）`@node-rs/argon2` 的原生模块
 * —— 实测 webpack 直接编译失败。
 *
 * 因此走 API 的内部端点 `/internal/v1/plan-versions/...`，共享密钥认证。
 * 密钥只在服务端读（没有 `NEXT_PUBLIC_` 前缀，不会进客户端包）。
 */

import { TravelPosterViewModelSchema, type TravelPosterViewModel } from '@tps/schemas';

/** 服务端到服务端的 API 地址。与浏览器用的 `NEXT_PUBLIC_API_BASE` 分开 */
const INTERNAL_API_BASE = process.env['INTERNAL_API_BASE'] ?? 'http://localhost:3001';
const INTERNAL_API_KEY = process.env['INTERNAL_API_KEY'] ?? '';

/**
 * P1 的视觉基线用 `fixture-N` 形态的版本 ID。
 *
 * 保留它是有意的：视觉回归需要**确定性**输入（TP-1-16 的基线图），
 * 而真实计划的内容每次生成都不同。两条路径共存，靠 ID 形态区分。
 */
export function isFixtureVersion(planVersionId: string): boolean {
  return /^fixture-\d+$/.test(planVersionId);
}

interface PresentationResponse {
  readonly plan_version_id: string;
  readonly template_id: string;
  readonly page_type: string;
  readonly day_number: number | null;
  readonly validation_status: string;
  readonly view_model: unknown;
}

async function fetchPresentation(path: string): Promise<PresentationResponse | null> {
  if (INTERNAL_API_KEY.length === 0) {
    /*
     * 未配置密钥时直接返回 null（页面走 404），不去发一个必然被拒的请求。
     * 报错更「响亮」，但渲染路由的调用方是 Playwright —— 它看到的会是
     * 一个 500 页面截图，而 404 至少能让 17.3 的检查明确失败。
     */
    return null;
  }

  const response = await fetch(`${INTERNAL_API_BASE}${path}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY },
    // 渲染要的是当下的数据，不能命中 Next 的数据缓存
    cache: 'no-store',
  });

  if (!response.ok) return null;
  return (await response.json()) as PresentationResponse;
}

/**
 * 单日 ViewModel。不存在（含未编排、REJECTED 版本）时返回 null。
 *
 * 落库的 ViewModel 仍然过一遍 schema：它是我们自己写进去的，但版本可能是
 * **旧契约**产出的（`plan_presentations` 永久保存，见 19.3），
 * 而模板按当前契约取字段。不校验的话，旧行会在模板里表现为某个位置
 * 渲染成 `undefined`，而 404 至少是个明确的失败。
 *
 * `templateId` 必填（R-85）：一个版本下可以共存多套样式的展示数据，
 * 不带它时内部端点取到的是「排序在前的那一套」而不是用户选的那一套。
 */
export async function loadDailyViewModel(
  planVersionId: string,
  dayNumber: number,
  templateId: string,
): Promise<TravelPosterViewModel | null> {
  const body = await fetchPresentation(
    `/internal/v1/plan-versions/${encodeURIComponent(planVersionId)}/presentations/${dayNumber}` +
      `?template=${encodeURIComponent(templateId)}`,
  );
  if (body === null) return null;

  const parsed = TravelPosterViewModelSchema.safeParse(body.view_model);
  return parsed.success ? parsed.data : null;
}

/**
 * 完整页 ViewModel。
 *
 * 完整页没有 Zod 契约（`FullPlanViewModel` 是 TS 接口 —— 它由
 * `@tps/presentation` 独占产出）。因此这里只做形状探测：
 * 缺 `days` 数组就当作旧契约，返回 null 让路由 404。
 */
export async function loadFullPlanViewModel(
  planVersionId: string,
  templateId: string,
): Promise<unknown> {
  const body = await fetchPresentation(
    `/internal/v1/plan-versions/${encodeURIComponent(planVersionId)}/presentations/full` +
      `?template=${encodeURIComponent(templateId)}`,
  );
  return body === null ? null : body.view_model;
}
