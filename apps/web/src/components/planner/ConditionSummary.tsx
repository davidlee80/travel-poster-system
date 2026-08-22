'use client';

import { CONDITION_LABEL } from '@tps/presentation';
import type { ConditionCode } from '@tps/schemas';

import { budgetTotal, tripDays, travelerCount, type PlannerState } from '@/lib/planner-state';
import type { ConditionStance } from '@/lib/travel-request-form';

/**
 * 右栏：已选条件摘要 + 冲突提示 + 提交（原型的 `.right-panel`）。
 *
 * ## 为什么摘要值得单独一栏
 *
 * 46 个标签散在四个区块里，用户点到第 6 步时已经不记得第 2 步勾了什么。
 * 而「必须」与「不要」是硬约束 —— 它们会让生成失败或产出很紧的行程，
 * 因此必须在提交前一眼可见。
 */

const GROUPS: readonly {
  readonly stance: ConditionStance;
  readonly title: string;
  readonly empty: string;
  readonly modifier: string;
}[] = [
  {
    stance: 'REQUIRE',
    title: '必须满足',
    empty: '尚未添加硬约束',
    modifier: 'planner-condition--require',
  },
  {
    stance: 'PREFER',
    title: '优先满足',
    empty: '尚未添加旅行偏好',
    modifier: 'planner-condition--prefer',
  },
  {
    stance: 'EXCLUDE',
    title: '明确不要',
    empty: '尚未添加排除项',
    modifier: 'planner-condition--exclude',
  },
];

function money(value: number): string {
  return `¥${value.toLocaleString('zh-CN')}`;
}

/**
 * 一条本地可判定的冲突提示。
 *
 * **只做一条，且只提示不阻断。** 完整的冲突判定是服务端 N-01～N-12 与
 * V-xx 的职责，前端复制一份必然与它分叉 —— 而分叉的表现是「前端说有冲突，
 * 提交却成功了」。这一条留着是因为它在提交前就能省掉一次失败的生成。
 */
function conflictOf(state: PlannerState): string | null {
  const wantsTransit = state.conditions['transport.public_transit'] !== undefined;
  if (wantsTransit && state.walkingLimitKm <= 3) {
    return '优先公共交通与「每天步行不超过 3 公里」在多数目的地难以同时满足，建议保留局部打车或放宽步行上限。';
  }
  return null;
}

export interface ConditionSummaryProps {
  readonly state: PlannerState;
  readonly onCycle: (code: ConditionCode) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
  readonly signedIn: boolean;
  readonly open: boolean;
}

export function ConditionSummary({
  state,
  onCycle,
  onSubmit,
  busy,
  signedIn,
  open,
}: ConditionSummaryProps): React.ReactElement {
  const entries = Object.entries(state.conditions) as readonly [ConditionCode, ConditionStance][];
  const total = budgetTotal(state);
  const conflict = conflictOf(state);

  return (
    <aside className={`planner-panel planner-right${open ? ' is-open' : ''}`}>
      <div className="planner-right__head">
        <h2>我的旅行条件</h2>
        <span className="planner-right__count">{entries.length} 项</span>
      </div>

      {GROUPS.map((group) => {
        const items = entries.filter(([, stance]) => stance === group.stance);
        return (
          <section key={group.stance} className="planner-condition-group">
            <div className="planner-condition-group__head">
              <strong>{group.title}</strong>
              <span>{items.length} 项</span>
            </div>

            {items.length === 0 ? (
              <p className="planner-condition-empty">{group.empty}</p>
            ) : (
              <div className="planner-condition-list">
                {items.map(([code]) => (
                  <div key={code} className={`planner-condition ${group.modifier}`}>
                    <span className="planner-condition__dot" />
                    <span className="planner-condition__text">{CONDITION_LABEL[code]}</span>
                    <button
                      type="button"
                      className="planner-condition__remove"
                      title={`移除「${CONDITION_LABEL[code]}」`}
                      onClick={() => onCycle(code)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {conflict === null ? null : (
        <div className="planner-conflict" role="note">
          <div className="planner-conflict__title">⚠ 潜在冲突</div>
          <p>{conflict}</p>
        </div>
      )}

      <div className="planner-estimate">
        <h3>当前方案预估</h3>
        <div className="planner-estimate__grid">
          <div>
            <strong>
              {money(total.min)}～{money(total.max)}
            </strong>
            <span>预计总预算</span>
          </div>
          <div>
            <strong>{tripDays(state)} 天</strong>
            <span>行程天数</span>
          </div>
          <div>
            <strong>{travelerCount(state)} 人</strong>
            <span>出行人数</span>
          </div>
          <div>
            <strong>≤ {state.walkingLimitKm} km</strong>
            <span>每日步行</span>
          </div>
        </div>
        {/*
          只显示能算准的四项。原型还有「可匹配方案 12 个」「换酒店 0 次」——
          那两个数字在原型里是编的，真实系统在生成前无从得知，
          放上去等于给用户一个凭空的承诺。
        */}
      </div>

      <div className="planner-right__actions">
        <button
          type="button"
          className="planner-button planner-button--primary planner-button--large"
          disabled={busy || !signedIn}
          title={signedIn ? undefined : '生成旅行计划需要先注册或登录'}
          onClick={onSubmit}
        >
          {busy ? '生成中…' : '生成旅行方案'}
        </button>

        {signedIn ? null : (
          <p className="planner-right__note" role="note">
            生成旅行计划需要先注册或登录 —— 计划会保存在你的账号下，换设备也能打开。{' '}
            {/*
              这句原本是纯文字，用户读完不知道去哪儿点。身份面板在 1250px 以下
              会排到页面最上方，而这里是第 7 步 —— 它在四千像素之上。
              锚点指向邮箱输入框本身（`AuthPanel` 的 `#auth-email`）：
              片段导航会把焦点落到可聚焦的目标上，因此不需要任何 JS。
            */}
            <a className="planner-right__auth-link" href="#auth-email">
              去注册或登录
            </a>
          </p>
        )}
      </div>
    </aside>
  );
}
