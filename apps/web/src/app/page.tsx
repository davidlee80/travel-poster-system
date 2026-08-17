import { AnonymousNotice } from '@/components/AnonymousNotice';
import { AuthPanel } from '@/components/AuthPanel';
import { PlanRequestForm } from '@/components/PlanRequestForm';
import { SessionProvider } from '@/components/SessionProvider';

/**
 * 首页（TP-1-40）。
 *
 * P1 只有身份相关的界面；P2 接入旅行需求表单与文字版计划页（TP-2-17）。
 * 每日信息图与长图导出在 P3/P4。
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
            <PlanRequestForm />
          </section>

          <aside className="home__aside">
            <AuthPanel />
          </aside>
        </div>
      </main>
    </SessionProvider>
  );
}
