/** 仅检查 Web 进程自身，不把上游短暂故障转成 liveness 失败。 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
