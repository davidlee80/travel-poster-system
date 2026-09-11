/** 能执行此处理器即表示 Web 可服务；不依赖 API、Redis 或业务配置。 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
