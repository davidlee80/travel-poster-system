'use client';

import type { PlannerFieldId, PlannerStepId } from '@tps/schemas';

import type { SummaryChip, SummarySection } from '@/lib/planner/summary';
import { TRIP_STATE_LABEL, type PlannerSnapshot } from '@/lib/planner/step-state';

/**
 * 右栏：旅行画像五组 + 关键数字 + 生成入口（规范 17）。
 *
 * ## chip 是按钮
 *
 * 规范 17.2 要求点击 chip 回跳来源 Step、滚动到字段并聚焦。做成 `<span>`
 * 的话键盘用户无法触发那个回跳 —— 而它是「用户随时能理解自己告诉了系统什么」
 * 这条体验目标的主要实现方式。
 *
 * ## 「系统自动研究」清单不是营销文案
 *
 * 规范 1.1 的第一条原则是「只问用户才知道的事」。用户判断「为什么不问我签证」
 * 的唯一途径就是看到这一栏 —— 没有它，那条原则在界面上不可见，
 * 表现为用户觉得这个问卷「漏了很多东西」。
 */

/** 后台自动研究的项目（规范 8 与 14 的 system-card 内容）*/
const RESEARCH_TOPICS = [
  '天气穿衣',
  '签证过境',
  '当地安全',
  '交通票制',
  '景点预约',
  '餐厅预约',
  '支付现金',
  '通信 eSIM',
] as const;

export interface SummaryRailProps {
  readonly sections: readonly SummarySection[];
  readonly snapshot: PlannerSnapshot;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly onJumpToField: (step: PlannerStepId, fieldId: PlannerFieldId) => void;
  readonly onGenerate: () => void;
  readonly onJumpToVerify: () => void;
  readonly generateDisabled: boolean;
  /** 窄屏抽屉是否展开 */
  readonly open: boolean;
}

export function SummaryRail({
  sections,
  snapshot,
  metrics,
  onJumpToField,
  onGenerate,
  onJumpToVerify,
  generateDisabled,
  open,
}: SummaryRailProps): React.ReactElement {
  const total = sections.reduce((sum, section) => sum + section.chips.length, 0);

  return (
    <aside
      className={`planner-panel planner-right${open ? ' planner-right--open' : ''}`}
      aria-label="我的旅行画像"
    >
      <div className="planner-right__head">
        <h2 className="planner-right__title">我的旅行画像</h2>
        <span className="planner-right__count">{total} 项</span>
      </div>

      {sections.map((section) => (
        <section
          key={section.group}
          className={`planner-snapshot${section.group === 'VERIFY' ? ' planner-snapshot--verify' : ''}`}
        >
          <h3 className="planner-snapshot__head">
            <span>{section.title}</span>
            {section.group === 'VERIFY' && snapshot.verifyCount > 0 ? (
              <span>待核验 · {snapshot.verifyCount}</span>
            ) : null}
          </h3>
          {section.chips.length === 0 ? (
            <p className="planner-chip__empty">尚未填写</p>
          ) : (
            <div className="planner-chips">
              {section.chips.map((chip) => (
                <Chip key={chip.fieldId} chip={chip} onJump={onJumpToField} />
              ))}
            </div>
          )}
        </section>
      ))}

      <div className="planner-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="planner-metric">
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>

      <div className="planner-right__actions">
        {/*
          按钮文案随 Trip State 变（规范 18 的状态表）。`blocked` 时**不禁用** ——
          规范原文：「按钮可点击但进入问题定位，不建议纯 disabled；
          避免用户不知道为何不能生成」。这里只有「正在生成」与「未登录」会禁用。
        */}
        <button
          type="button"
          className="planner-button planner-button--primary planner-button--large"
          onClick={onGenerate}
          disabled={generateDisabled}
        >
          {generateLabel(snapshot)}
        </button>
        {snapshot.verifyCount > 0 ? (
          <button
            type="button"
            className="planner-button planner-button--secondary"
            onClick={onJumpToVerify}
          >
            查看待确认项
          </button>
        ) : null}
      </div>

      <p className="planner-right__note">{TRIP_STATE_LABEL[snapshot.tripState]}</p>

      <div className="planner-research">
        <strong>系统自动研究，不要求你填写</strong>
        <ul>
          {RESEARCH_TOPICS.map((topic) => (
            <li key={topic}>{topic}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function Chip({
  chip,
  onJump,
}: {
  readonly chip: SummaryChip;
  readonly onJump: (step: PlannerStepId, fieldId: PlannerFieldId) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`planner-chip planner-chip--${chip.kind}`}
      onClick={() => onJump(chip.step, chip.fieldId)}
      /*
       * aria-label 里带上「前往第 N 步修改」：chip 的可见文字是它的内容，
       * 而屏读用户需要知道点它会发生什么。只读内容的话它听起来像一段静态文本。
       */
      aria-label={`${chip.text}，前往第 ${chip.step} 步修改`}
      title={chip.blocking ? '这一项会影响生成' : undefined}
    >
      {chip.text}
    </button>
  );
}

function generateLabel(snapshot: PlannerSnapshot): string {
  if (snapshot.tripState === 'research-needed') {
    return `生成初步方案 · 仍有 ${snapshot.verifyCount} 项待确认`;
  }
  if (snapshot.tripState === 'blocked') return '查看待处理的问题';
  return '生成初步旅行方案';
}
