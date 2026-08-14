import { AnonymousNotice } from '@/components/AnonymousNotice';
import { AuthPanel } from '@/components/AuthPanel';
import { SessionProvider } from '@/components/SessionProvider';

/**
 * 首页（TP-1-40）。
 *
 * P1 只有身份相关的界面：注册 / 登录 / 登出 + 匿名状态提示条。
 * 旅行需求表单在 P2（提交生成请求）、完整信息图展示在 P3。
 */
export default function HomePage() {
  return (
    <SessionProvider>
      <main className="home">
        <header className="home__head">
          <h1 className="home__title">旅行计划信息图</h1>
          <p className="home__lead">
            提交旅行诉求，自动生成可浏览的完整计划、每日信息图、PNG 长图与 PDF。
          </p>
        </header>

        <div className="home__grid">
          <section className="home__main">
            <AnonymousNotice />
            <div className="home__placeholder">
              <h2>旅行需求表单</h2>
              <p>P2 实现。届时可直接提交生成请求 —— 未注册也能使用。</p>
            </div>
          </section>

          <aside className="home__aside">
            <AuthPanel />
          </aside>
        </div>
      </main>
    </SessionProvider>
  );
}
