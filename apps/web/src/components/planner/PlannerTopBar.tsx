'use client';

/**
 * 顶栏（原型的 `.topbar`）。
 *
 * 原型还有一个「保存草稿」按钮，写 localStorage。这里**不做** ——
 * P7 之后一切请求都必须是注册用户，计划本来就存在账号下（13.9.5 有历史列表），
 * 再加一份浏览器本地草稿会造出第二个真相源：换设备后本地草稿不在，
 * 而用户以为自己存过。
 */

export interface PlannerTopBarProps {
  readonly onReset: () => void;
  readonly onToggleMenu: () => void;
  readonly children?: React.ReactNode;
}

export function PlannerTopBar({
  onReset,
  onToggleMenu,
  children,
}: PlannerTopBarProps): React.ReactElement {
  return (
    <header className="planner-topbar">
      <div className="planner-brand">
        <button
          type="button"
          className="planner-button planner-button--light planner-menu-button"
          title="展开规划步骤"
          onClick={onToggleMenu}
        >
          ☰
        </button>
        <div className="planner-brand__logo">✳</div>
        <div>
          <strong>自由行智能规划器</strong>
          <small>结构化采集旅行诉求，生成一张行程信息图</small>
        </div>
      </div>

      <div className="planner-topbar__actions">
        {children}
        <button type="button" className="planner-button planner-button--light" onClick={onReset}>
          重新开始
        </button>
      </div>
    </header>
  );
}
