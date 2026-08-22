import type { Metadata } from 'next';
import { loadLegalDocument } from '@/lib/legal-document';

/**
 * 用户协议与隐私政策（`/legal`）。
 *
 * 注册表单收邮箱与口令，在此之前前端**没有任何政策入口** —— 文档只存在于
 * `docs/`。这一页就是那个入口。
 *
 * `force-static`：内容来自构建期读到的 `docs/用户协议与隐私政策.md`，
 * 每个用户看到的完全一样。声明成静态不只是优化 —— 运行期镜像里没有 `docs/`
 * （只有构建阶段拷了它），若这一页变成动态渲染，线上第一次访问就会 500。
 *
 * **代价：改完那份 markdown 要重建 web 镜像**（`pnpm mvp:build`），
 * 光重启容器不会更新这一页。表现是「文档明明改了，页面还是旧的」。
 */
export const dynamic = 'force-static';

const document = loadLegalDocument();

export const metadata: Metadata = {
  title: document.title,
};

export default function LegalPage(): React.ReactElement {
  return (
    <main className="legal">
      <p className="legal__back">
        <a href="/">← 返回</a>
      </p>
      <h1>{document.title}</h1>
      {/*
        输入是仓库里的一个 markdown 文件，构建期读入，不含任何用户输入 ——
        因此这里没有注入面。见 `lib/legal-document.ts` 的说明。
      */}
      <div className="legal__body" dangerouslySetInnerHTML={{ __html: document.html }} />
    </main>
  );
}
