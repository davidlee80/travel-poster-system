'use client';

import { PLANNER_STEPS, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import { Icon } from '@/components/Icon';
import type { PlannerAction, PlannerState } from '@/lib/planner/state';
import type { PlannerSnapshot } from '@/lib/planner/step-state';

import { FieldControl } from './controls/FieldControl';
import { STEP_SECTIONS, type PlannerSection } from './steps/sections';

/**
 * 一个步骤页（规范 3.2 的 Main Header + Main Sections + Sticky Action）。
 *
 * ## 未触发的字段一行都不渲染
 *
 * 规范 6：未触发字段隐藏，不占完成度。渲染成禁用状态是另一种常见做法，
 * 但它会让第 8 步永远显示十行灰掉的证件问题 —— 而那正是 V2 想消除的
 * 「大而全问卷」观感。整组字段都未触发时连小标题一起隐藏，
 * 否则会留下一个空标题（比如国内游的「证件」组）。
 *
 * ## 九步共用一个组件
 *
 * 每一步的差别只有两样：区块小标题（在 `steps/sections.ts` 里）与第 9 步的
 * 复核面板（通过 `slots` 注入）。九个各自罗列字段的组件等于把字段清单抄第二遍，
 * 而元数据表的数组顺序已经是页面区块顺序。
 */

export interface StepPageProps {
  readonly step: PlannerStepId;
  readonly active: boolean;
  readonly state: PlannerState;
  readonly snapshot: PlannerSnapshot;
  readonly dispatch: (action: PlannerAction) => void;
  readonly onPrev: (() => void) | null;
  readonly onNext: (() => void) | null;
  /** 第 9 步用它替换「下一步」 */
  readonly nextLabel: string | null;
  readonly registerField: (fieldId: PlannerFieldId, node: HTMLElement | null) => void;
  /** 某些字段的内容由本步骤的专用面板承载（第 9 步的复核面板与阻塞项列表） */
  readonly slots?: Partial<Record<PlannerFieldId, React.ReactNode>>;
  /** 被组合控件承载、无需重复显示的底层字段。字段仍保留在数据契约和状态机中。 */
  readonly hiddenFields?: readonly PlannerFieldId[];
  /**
   * 字段区块之后、底部动作区之前的内容（第 9 步的输出样式选择器）。
   *
   * 与 `slots` 分开是因为 `slots` 的键是 `PlannerFieldId` ——
   * 而这里要放的东西没有对应字段（模板不在 76 字段里）。
   * 与 `actions` 分开是因为后者在 `planner-actions__right` 里，
   * 那是一排按钮的位置，放不下一组带图的卡片。
   */
  readonly beforeActions?: React.ReactNode;
  /** 底部动作区右侧的额外内容（第 9 步的生成按钮） */
  readonly actions?: React.ReactNode;
}

export function StepPage({
  step,
  active,
  state,
  snapshot,
  dispatch,
  onPrev,
  onNext,
  nextLabel,
  registerField,
  slots,
  hiddenFields = [],
  beforeActions,
  actions,
}: StepPageProps): React.ReactElement {
  const meta = PLANNER_STEPS.find((entry) => entry.step === step);
  const triggered = new Set(snapshot.triggered);
  const hidden = new Set(hiddenFields);
  const sections = STEP_SECTIONS[step];

  return (
    <section
      className={`planner-panel planner-step-page${active ? ' planner-step-page--active' : ''}`}
      data-step={step}
      aria-labelledby={`planner-step-title-${step}`}
      /*
       * `aria-hidden` 与 display:none 一起用是多余的（display:none 已经把子树
       * 从无障碍树里摘掉），因此不加 —— 加了反而会在将来有人把它改成
       * visibility 隐藏时掩盖问题。
       */
    >
      <header className="planner-page-head">
        <div className="planner-page-head__content">
          <div className="planner-page-head__eyebrow">
            {step} · {meta?.nav ?? ''}
          </div>
          <h1 className="planner-page-head__title" id={`planner-step-title-${step}`}>
            {meta?.title ?? ''}
          </h1>
          <p className="planner-page-head__desc">{meta?.intro ?? ''}</p>
        </div>
        <div className="planner-page-head__hero">
          <img
            src="/images/hero/travel-hero.svg"
            alt=""
            className="planner-page-head__hero-img"
            aria-hidden="true"
          />
        </div>
        <span className="planner-page-head__badge">第 {Number(step)} 步 / 9</span>
      </header>

      <div className="planner-required-legend" role="note">
        <span className="planner-badge planner-badge--required">必填项</span>
        <span>“当前必填”会随你的选择出现；其他问题可以跳过。</span>
      </div>

      {(() => {
        const visibleSections = sections.flatMap((section) => {
          const fields = section.fields.filter(
            (fieldId) => triggered.has(fieldId) && !hidden.has(fieldId),
          );
          return fields.length === 0 ? [] : [{ section, fields }];
        });
        const groups: {
          key: string;
          layoutGroup?: PlannerSection['layoutGroup'];
          sections: typeof visibleSections;
        }[] = [];
        for (const item of visibleSections) {
          const last = groups[groups.length - 1];
          if (
            item.section.layoutGroup !== undefined &&
            last?.layoutGroup === item.section.layoutGroup
          ) {
            last.sections.push(item);
          } else {
            groups.push({
              key: item.section.title,
              layoutGroup: item.section.layoutGroup,
              sections: [item],
            });
          }
        }

        const renderSection = ({
          section,
          fields,
        }: (typeof visibleSections)[number]): React.ReactElement => (
          <div className="planner-block" key={section.title}>
            <h2 className="planner-block__title">
              {section.icon ? (
                <Icon
                  name={section.icon}
                  size={24}
                  className={`planner-block__icon${
                    section.iconColor ? ` planner-block__icon--${section.iconColor}` : ''
                  }`}
                />
              ) : null}
              {section.title}
            </h2>
            {section.intro === undefined ? null : (
              <p className="planner-block__intro">{section.intro}</p>
            )}
            {fields.map((fieldId) => (
              <FieldControl
                key={fieldId}
                fieldId={fieldId}
                state={state}
                snapshot={snapshot}
                dispatch={dispatch}
                registerField={registerField}
                {...(slots?.[fieldId] === undefined ? {} : { slot: slots[fieldId] })}
              />
            ))}
            {step === '04' ? <Step4Decoration section={section} /> : null}
          </div>
        );

        return groups.map((group) =>
          group.layoutGroup === undefined ? (
            group.sections.map(renderSection)
          ) : (
            <div className={`planner-layout planner-layout--${group.layoutGroup}`} key={group.key}>
              {group.sections.map(renderSection)}
            </div>
          ),
        );
      })()}

      {beforeActions}

      <div className="planner-actions">
        <div className="planner-actions__left">
          {onPrev === null ? null : (
            <button
              type="button"
              className="planner-button planner-button--secondary"
              onClick={onPrev}
            >
              ← 上一步
            </button>
          )}
        </div>
        <div className="planner-actions__right">
          <span className="planner-actions__note">修改会自动保存</span>
          {actions}
          {onNext === null ? null : (
            <button
              type="button"
              className="planner-button planner-button--primary"
              onClick={onNext}
            >
              {nextLabel ?? '下一步'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Step4Decoration({
  section,
}: {
  readonly section: PlannerSection;
}): React.ReactElement | null {
  if (section.fields.includes('PV2-04-003')) {
    return (
      <svg
        className="planner-step4-art planner-step4-art--footprints"
        data-step4-art="footprints"
        viewBox="0 0 50 70"
        aria-hidden="true"
      >
        <path
          d="M28 3c-8-2-12 5-7 11 4 4 10 4 11 12 1 8 10 12 13 4 3-9-7-24-17-27Z"
          fill="#bddff9"
        />
        <ellipse cx="37" cy="40" rx="4" ry="5" fill="#c4e6fb" />
        <path
          d="M16 21c-8-1-13 10-12 21 1 11 6 17 12 15 6-2 6-8 2-13-3-5 7-20-2-23Z"
          fill="#c9e9fc"
        />
        <ellipse cx="12" cy="64" rx="4" ry="3" fill="#c4e6fb" />
        <ellipse cx="21" cy="61" rx="3" ry="4" fill="#c4e6fb" />
      </svg>
    );
  }
  if (section.fields.includes('PV2-04-007')) {
    return (
      <svg
        className="planner-step4-art planner-step4-art--hotel"
        data-step4-art="hotel"
        viewBox="0 0 32 43"
        aria-hidden="true"
      >
        <path d="M11 13V3h9v10" fill="none" stroke="#8585bc" strokeWidth="2" />
        <path d="M12 3h7" stroke="#b7b8e8" strokeWidth="3" strokeLinecap="round" />
        <rect x="5" y="12" width="23" height="25" rx="4" fill="#a09bf4" />
        <rect x="5" y="12" width="13" height="25" rx="4" fill="#c4c0ff" />
        <path d="M12 17v15m10-15v15" stroke="#e2ddff" strokeWidth="1.3" />
        <circle cx="10" cy="39" r="2" fill="#7774aa" />
        <circle cx="24" cy="39" r="2" fill="#7774aa" />
      </svg>
    );
  }
  return null;
}
