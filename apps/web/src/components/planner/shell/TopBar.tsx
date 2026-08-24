'use client';

import { SAVE_STATE_LABEL, type SaveState } from '@/lib/planner/persistence';

/**
 * 顶栏（规范 3.2）：品牌 / 自动保存状态 / 字段标识（Dev）/ 账号入口。
 *
 * ## 保存状态为什么是一个按钮而不是一段文字
 *
 * 规范 6：「失败不阻断编辑但需可重试」。做成纯文字的话「保存失败」是一句
 * 没有出路的话 —— 用户唯一能想到的动作是刷新，而那恰好会丢掉未保存的内容。
 * 失败态下它可点击并重试；其余状态下它是 `aria-live` 区域，不可点。
 */

export interface TopBarProps {
  readonly saveState: SaveState;
  readonly onRetrySave: () => void;
  readonly devMode: boolean;
  readonly onToggleDevMode: () => void;
  /** 是否显示 Dev Mode 开关。生产端默认隐藏（规范 21.1）*/
  readonly showDevToggle: boolean;
  readonly onReset: () => void;
  readonly onToggleMenu: () => void;
  /** 账号入口。由调用方传入 `<AuthPanel />`，本组件不关心登录逻辑 */
  readonly children: React.ReactNode;
}

export function TopBar({
  saveState,
  onRetrySave,
  devMode,
  onToggleDevMode,
  showDevToggle,
  onReset,
  onToggleMenu,
  children,
}: TopBarProps): React.ReactElement {
  const failed = saveState === 'failed';

  return (
    <header className="planner-topbar">
      <div className="planner-brand">
        <button
          type="button"
          className="planner-menu-button planner-button planner-button--light"
          onClick={onToggleMenu}
          aria-label="打开步骤导航"
        >
          ☰
        </button>
        <span className="planner-brand__logo" aria-hidden="true">
          ✦
        </span>
        <div>
          <strong>自由行智能规划器</strong>
          <small>私人旅行规划服务</small>
        </div>
      </div>

      <div className="planner-topbar__actions">
        {/*
          `aria-live="polite"`：保存状态是自动变化的，屏读用户需要被动知道它。
          用 polite 而不是 assertive —— 它不该打断用户正在填的那个字段。
        */}
        <button
          type="button"
          className="planner-save-state"
          onClick={failed ? onRetrySave : undefined}
          disabled={!failed}
          aria-live="polite"
        >
          <i className={`planner-save-state__dot planner-save-state__dot--${saveState}`} />
          {SAVE_STATE_LABEL[saveState]}
        </button>

        {showDevToggle ? (
          <button
            type="button"
            className="planner-button planner-button--light"
            onClick={onToggleDevMode}
            aria-pressed={devMode}
          >
            字段标识
          </button>
        ) : null}

        <button type="button" className="planner-button planner-button--light" onClick={onReset}>
          重新开始
        </button>

        {children}
      </div>
    </header>
  );
}
