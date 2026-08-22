'use client';

import { useEffect, useRef } from 'react';

import { dialogViewFor, type GenerationPhase } from '@/lib/generation-dialog';

/**
 * 生成等待弹层。
 *
 * ## 为什么必须是弹层，而不是页面里的一张卡片
 *
 * 在这之前进度条是内联在主栏最后一张表单卡之后的。而「生成旅行方案」按钮
 * 在右栏的 sticky 区里 —— 用户在第 1 步就能点到它，此时进度条在四千多像素
 * 之下，页面也不会自动滚过去。表现是**点完按钮之后什么都没发生**，
 * 而实际上任务已经在跑了。
 *
 * ## 覆盖的是「提交之后的全过程」
 *
 * submitting / generating / ready / error 四个阶段都在这里显示，不只是等待中。
 * 只覆盖等待的话，一到 `ready` 弹层消失、用户被丢回表单，而「查看完整计划」
 * 那个链接仍在四千像素之下 —— 等于没解决要解决的问题。
 *
 * ## 关闭策略
 *
 * 生成中不给关闭（`dismissible` 为 false）：轮询挂在 Planner 上，关掉弹层它
 * 还在跑，但用户再也看不到结果。到 `ready` / `error` 才放开 Esc 与关闭按钮。
 *
 * 视图文案与百分比全部由 `dialogViewFor` 推导（那是个可测的纯函数），
 * 这里只负责摆位置与无障碍属性。
 */

export interface GenerationDialogProps {
  readonly phase: GenerationPhase;
  /** 关闭。只在 `dismissible` 时会被调用 */
  readonly onClose: () => void;
}

export function GenerationDialog({
  phase,
  onClose,
}: GenerationDialogProps): React.ReactElement | null {
  const view = dialogViewFor(phase);
  const panel = useRef<HTMLDivElement>(null);

  /*
   * 打开时把焦点移进弹层。
   *
   * 不做的话焦点还留在「生成旅行方案」按钮上 —— 屏幕阅读器用户不知道
   * 页面上多了东西，键盘用户按 Tab 会走到被遮住的表单里去。
   */
  useEffect(() => {
    if (view !== null) panel.current?.focus();
  }, [view === null]);

  /** Esc 关闭，但只在允许关闭时。生成中按 Esc 什么都不发生 */
  useEffect(() => {
    if (view === null || !view.dismissible) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view === null, view?.dismissible, onClose]);

  if (view === null) return null;

  return (
    <div className="planner-dialog" role="presentation">
      {/*
        遮罩只在可关闭时响应点击：生成中点它没有反应是有意的 ——
        一个「点了没反应」的遮罩比一个会让用户丢失结果的遮罩好。
      */}
      <div
        className="planner-dialog__scrim"
        onClick={view.dismissible ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        className={`planner-dialog__panel planner-dialog__panel--${view.tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-dialog-title"
        aria-describedby="generation-dialog-lines"
        tabIndex={-1}
        ref={panel}
      >
        <div className="planner-dialog__head">
          <h2 className="planner-dialog__title" id="generation-dialog-title">
            {view.title}
          </h2>
          {view.dismissible ? (
            <button
              type="button"
              className="planner-dialog__close"
              onClick={onClose}
              aria-label="关闭"
            >
              ×
            </button>
          ) : null}
        </div>

        {/*
          两行文字在进度条**上方**。
          `aria-live="polite"` 让阶段变化被读出来，而 polite 而不是 assertive
          是因为它每两秒可能变一次 —— assertive 会打断用户正在听的内容。
        */}
        <div className="planner-dialog__lines" id="generation-dialog-lines" aria-live="polite">
          <p className="planner-dialog__line planner-dialog__line--primary">{view.lines[0]}</p>
          <p className="planner-dialog__line planner-dialog__line--secondary">{view.lines[1]}</p>
        </div>

        {/* percent 为 null（失败态）时整条进度条都不画，见 dialogViewFor 的注释 */}
        {view.percent !== null ? (
          <div className="planner-dialog__meter">
            <div
              className={`planner-dialog__track${
                view.percent === 'indeterminate' ? ' is-indeterminate' : ''
              }`}
              role="progressbar"
              aria-label="生成进度"
              /*
               * 不确定进度时**不写** aria-valuenow：按 ARIA 规范那正是
               * 「进度未知」的表达方式，写成 0 会被读成「已完成 0%」。
               */
              {...(view.percent === 'indeterminate'
                ? {}
                : { 'aria-valuenow': view.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
            >
              <div
                className="planner-dialog__fill"
                style={view.percent === 'indeterminate' ? undefined : { width: `${view.percent}%` }}
              />
            </div>
            <span className="planner-dialog__percent">
              {view.percent === 'indeterminate' ? '—' : `${view.percent}%`}
            </span>
          </div>
        ) : null}

        {view.planId !== null ? (
          <a
            className="planner-button planner-button--primary planner-dialog__cta"
            href={`/plans/${view.planId}`}
          >
            查看完整计划
          </a>
        ) : null}
      </div>
    </div>
  );
}
