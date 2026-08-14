import { SCHEMA_VERSIONS } from '@tps/schemas';

/**
 * 首页（P0 占位）。
 *
 * 真实界面按实施计划推进：
 *   P1  注册 / 登录 / 登出、匿名状态提示条（TP-1-40）
 *   P2  旅行需求表单、文字版完整计划
 *   P3  完整信息图页面
 */
export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '3rem 1.5rem', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>旅行计划信息图系统</h1>
      <p style={{ color: '#666', marginTop: 0 }}>P0 骨架已就位。界面从 P1 开始实现。</p>
      <p style={{ fontSize: '0.875rem', color: '#888' }}>
        契约版本：<code>{SCHEMA_VERSIONS.travelPosterViewModel}</code>
      </p>
    </main>
  );
}
