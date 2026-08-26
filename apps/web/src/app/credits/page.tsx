import type { Metadata } from 'next';

import { CreditLedger } from '@/components/CreditLedger';
import { SessionProvider } from '@/components/SessionProvider';

/**
 * 消费明细（`/credits`，C-6）。
 *
 * 入口在账号面板里（只在装配了计费时出现）。这一页**不做静态化**：
 * 它的全部内容都取决于当前身份，而 `/legal` 那种 `force-static` 的前提是
 * 「每个用户看到的完全一样」。
 */

export const metadata: Metadata = {
  title: 'CR 消费明细',
};

export default function CreditsPage(): React.ReactElement {
  return (
    <main className="credits">
      <p className="credits__back">
        <a href="/">← 返回</a>
      </p>
      <h1>CR 消费明细</h1>
      <SessionProvider>
        <CreditLedger />
      </SessionProvider>
    </main>
  );
}
