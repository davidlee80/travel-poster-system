'use client';

import { useSession } from './SessionProvider';

/**
 * 匿名状态提示条（TP-1-40，设计稿二十章「匿名用户的额外声明义务」）。
 *
 * ## 这不是可选的 UI 装饰
 *
 * 匿名用户没有账号可以行使删除权，因此设计稿二十章要求**必须在首次生成前
 * 明确告知**保留期与访问范围：
 *
 *   未登录状态下生成的计划保存 30 天，仅当前浏览器可访问。
 *   注册账号可长期保存并跨设备访问。
 *
 * 文案与隐私政策必须一致（TP-5-14）—— 界面说 30 天而政策说别的，
 * 等于没有有效告知。
 */

export function AnonymousNotice() {
  const { status } = useSession();

  // loading 时不显示：闪一下再消失比不显示更差
  /*
   * P7：`anonymous` 态**不**渲染这条提示。
   *
   * 提示条的内容是「未登录状态下生成的计划保存 30 天」—— 那句话的前提是
   * 未登录也能生成。匿名入口关闭后它变成了一句错误承诺：访客根本生不成计划，
   * 而这条提示会让他以为可以直接开始。
   *
   * 文案常量保留在下方（未被渲染）：`pnpm test:docs` 校验界面提示条与隐私
   * 政策的保留期是同一个数字，删掉文案会让那条一致性断言失去锚点 ——
   * 而政策里那 30 天仍然有效（存量匿名数据照常按 30 天清理）。
   */
  if (status.kind !== 'ready' || status.session.user_type !== 'ANONYMOUS') {
    return null;
  }

  return (
    <aside className="anon-notice" role="status">
      <span className="anon-notice__badge">访客模式</span>
      <p className="anon-notice__text">
        未登录状态下生成的计划<strong>保存 30 天</strong>，且仅当前浏览器可访问。
        注册账号可长期保存并跨设备访问，已生成的计划会自动保留。
      </p>
    </aside>
  );
}
