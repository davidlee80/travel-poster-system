'use client';

import { useEffect, useState } from 'react';

import { quoteCredits, type CreditQuoteResponse } from '@/lib/api-client';
import { creditHint, type CreditHintView } from '@/lib/credits';

/**
 * 生成按钮旁的 CR 报价（C-6）。
 *
 * ## 为什么报价是一次请求，而不是前端拿单价算
 *
 * 价目表是运营数据，且下发之后前端与服务端会各算一份 —— 分叉的表现是
 * **「按钮说够、提交被拒」**，而用户看到的只有一个 402。因此「够不够」
 * 这个结论由服务端给（`sufficient`），前端只负责禁用按钮。
 *
 * ## 为什么只在天数变化时请求
 *
 * 报价只取决于天数（其余答案不进估算，见服务端的 `estimateJobCost`）。
 * 按整份表单的任何改动去请求的话，用户每敲一个字都会打一次后端 ——
 * 而九步问卷有 76 个字段。
 *
 * 天数为 null（还没填日期）时不请求：那时没有可估的对象，
 * 而拿一个猜的天数报价会让用户看到一个之后会变的数字。
 */

export interface CreditQuoteState {
  readonly quote: CreditQuoteResponse | null;
  readonly hint: CreditHintView;
  /** 余额不够 —— 调用方据此禁用生成按钮 */
  readonly insufficient: boolean;
}

const IDLE: CreditQuoteState = {
  quote: null,
  hint: creditHint(null),
  insufficient: false,
};

/**
 * 取一次报价。`enabled` 为 false 时（未装配计费、未登录）不发请求。
 *
 * 请求失败时**不禁用按钮**：报价只是提示，而闸门在服务端。
 * 一次报价请求失败就让人点不了生成，是把一个装饰性功能变成了阻断项。
 */
export function useCreditQuote(totalDays: number | null, enabled: boolean): CreditQuoteState {
  const [state, setState] = useState<CreditQuoteState>(IDLE);

  useEffect(() => {
    if (!enabled || totalDays === null) {
      setState(IDLE);
      return;
    }

    let active = true;
    void quoteCredits(totalDays).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setState(IDLE);
        return;
      }
      setState({
        quote: result.data,
        hint: creditHint(result.data),
        insufficient: !result.data.sufficient && result.data.hold_cr > 0,
      });
    });

    /*
     * 天数在请求在途时又变了：丢掉这一次的结果。
     * 不丢的话两次响应的顺序不保证，用户可能看到旧天数的报价。
     */
    return () => {
      active = false;
    };
  }, [totalDays, enabled]);

  return state;
}

/** 报价提示。`hidden` 时不渲染任何东西 */
export function CreditHint({ hint }: { readonly hint: CreditHintView }): React.ReactElement | null {
  if (hint.kind === 'hidden') return null;

  return (
    <span
      className={`planner-actions__note${hint.kind === 'insufficient' ? ' planner-actions__note--warn' : ''}`}
      /* 余额不足是阻断项，要让读屏软件念出来；够用时只是参考信息 */
      role={hint.kind === 'insufficient' ? 'alert' : undefined}
    >
      {hint.text}
      <small>{hint.detail}</small>
    </span>
  );
}
