import { NextResponse, type NextRequest } from 'next/server';
import {
  isUsableSigningKey,
  parseRenderPath,
  verifyRenderTokenEdge,
} from '@/lib/render-token-edge';

/**
 * `/render/**` 的访问控制（TP-1-07，设计稿 17.1）。
 *
 * ## 为什么必须有这一层
 *
 * V1.0 只写了「该路由只供内部渲染服务访问」而无任何机制。仅靠网络隔离不够 ——
 * 该路由返回的是**用户私有计划内容**，任何内网服务被攻破即可遍历
 * `plan_version_id`。因此：网络层（Ingress 拒绝该前缀）+ 本中间件的 HMAC 令牌。
 *
 * ## 三个具体决定
 *
 * 1. **失败返回 404 而不是 403**。403 会告诉攻击者「这个版本 ID 存在」。
 * 2. **令牌与页面绑定**。签名有效 ≠ 允许访问当前页面，否则一个「第 1 天」
 *    的令牌就能取到全部 14 天。绑定校验在 verifyRenderTokenEdge 内完成。
 * 3. **未配置签名密钥时拒绝全部请求**（fail closed）。配置缺失是部署错误，
 *    fail open 会让内部路由在无人察觉的情况下完全敞开。
 *
 * jti 的一次性校验不在此处（Edge 运行时无法连 Redis）：
 * 重放窗口由 120 秒有效期压到最小，一次性检测在渲染 Worker 侧完成。
 */

const RENDER_TOKEN_HEADER = 'x-render-token';

export const config = {
  matcher: '/render/:path*',
};

function deny(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const signingKey = process.env['RENDER_SIGNING_KEY'];
  if (!isUsableSigningKey(signingKey)) return deny();

  const expected = parseRenderPath(request.nextUrl.pathname);
  if (expected === null) return deny();

  const token = request.headers.get(RENDER_TOKEN_HEADER);
  if (token === null || token.length === 0) return deny();

  const result = await verifyRenderTokenEdge(token, expected, signingKey);
  if (!result.valid) return deny();

  const response = NextResponse.next();
  // 渲染产物含用户私有内容，不应被任何中间层缓存或索引
  response.headers.set('cache-control', 'no-store, no-cache, must-revalidate, private');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  return response;
}
