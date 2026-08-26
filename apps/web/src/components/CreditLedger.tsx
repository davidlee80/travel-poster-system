'use client';

import { useCallback, useEffect, useState } from 'react';

import { getCreditLedger, type LedgerEntryView } from '@/lib/api-client';
import { entryTime, ledgerKindLabel, signedCr, visibleEntries } from '@/lib/credits';
import { useSession } from '@/components/SessionProvider';

/**
 * 消费明细（`/credits`，C-6）。
 *
 * ## 为什么单独一页而不是塞进账号面板
 *
 * 账号面板是个弹层，而流水是要翻的 —— 一个能翻页的列表放在弹层里，
 * 用户点「下一页」时弹层的高度会跳，而点外面又会把它关掉。
 *
 * ## 未登录时不显示「加载失败」
 *
 * 三态分开与 `SessionProvider` 同一条理由：把「未登录」显示成故障会让人
 * 去刷新页面，而刷一万次也不会有身份。这里直接引导回首页登录。
 */

type LoadState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly entries: readonly LedgerEntryView[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'error'; readonly message: string };

export function CreditLedger(): React.ReactElement {
  const { status } = useSession();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  const signedIn = status.kind === 'ready';

  const load = useCallback(async (before?: string) => {
    const result = await getCreditLedger(before === undefined ? {} : { before });
    if (!result.ok) {
      setState({ kind: 'error', message: result.message });
      return;
    }
    setState((current) => ({
      kind: 'ready',
      /* 翻页是**追加**而不是替换：翻到第三页再回头看第一页不该要重新加载 */
      entries: [
        ...(current.kind === 'ready' && before !== undefined ? current.entries : []),
        ...result.data.items,
      ],
      nextCursor: result.data.next_cursor,
    }));
  }, []);

  useEffect(() => {
    /* 等身份就绪再请求：抢在前面发一次必然 401 */
    if (!signedIn) return;
    void load();
  }, [signedIn, load]);

  if (status.kind === 'loading') {
    return <p className="credits__status">正在加载…</p>;
  }

  if (!signedIn) {
    return (
      <p className="credits__status">
        请先<a href="/">回到首页登录</a>，之后这里会显示你的 CR 消费明细。
      </p>
    );
  }

  const wallet = status.session.wallet;

  return (
    <>
      {wallet === undefined ? (
        /*
         * 计费没装配（`CREDIT_BILLING_ENABLED=false`）：这一页此刻没有内容，
         * 而且那三个端点压根没注册。说清楚而不是显示一个空列表 ——
         * 空列表读起来是「你一笔都没花过」，那是另一件事。
         */
        <p className="credits__status">当前部署未启用 CR 计费，生成与导出不消耗额度。</p>
      ) : (
        <div className="credits__summary">
          <div>
            <strong>{wallet.balance_cr}</strong>
            <span>可用 CR ≈ {wallet.balance_cny} 元</span>
          </div>
          <div>
            <strong>{wallet.held_cr}</strong>
            <span>生成中冻结</span>
          </div>
        </div>
      )}

      {state.kind === 'loading' ? <p className="credits__status">正在加载明细…</p> : null}
      {state.kind === 'error' ? (
        <p className="credits__status credits__status--error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.kind === 'ready' ? <Entries state={state} /> : null}

      {state.kind === 'ready' && state.nextCursor !== null ? (
        <button
          type="button"
          className="planner-button planner-button--secondary"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(state.nextCursor ?? undefined).finally(() => setLoadingMore(false));
          }}
        >
          {loadingMore ? '正在加载…' : '加载更早的记录'}
        </button>
      ) : null}
    </>
  );
}

function Entries({
  state,
}: {
  readonly state: { readonly entries: readonly LedgerEntryView[] };
}): React.ReactElement {
  const rows = visibleEntries(state.entries);
  if (rows.length === 0) {
    return <p className="credits__status">还没有消费记录。</p>;
  }

  return (
    <ul className="credits__list">
      {rows.map((entry) => (
        <li key={entry.entry_id} className="credits__row">
          <span className="credits__kind">{ledgerKindLabel(entry.kind)}</span>
          <span className={`credits__amount${entry.amount_cr < 0 ? ' credits__amount--out' : ''}`}>
            {signedCr(entry.amount_cr)}
          </span>
          <span className="credits__meta">
            {entryTime(entry.created_at)}
            <small>余额 {entry.balance_after_cr} CR</small>
          </span>
        </li>
      ))}
    </ul>
  );
}
