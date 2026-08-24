'use client';

import { plannerField, type PlannerFieldId } from '@tps/schemas';

import type { FieldState } from '@/lib/planner/field-state';
import { hasValidator } from '@/lib/planner/validation';

/**
 * Dev Mode 徽标（规范 21.1 的显示项表）。
 *
 * 七项逐条对应规范给的表格：Field ID / API Key / Runtime Type / Priority /
 * Blocking / Trigger Source / Field State。少一项就少一条排查线索 ——
 * 这个开关存在的意义是让 QA 能在界面上核对字段绑定，而不必开 DevTools。
 *
 * 生产端默认隐藏：由 URL 上的 `?dev=1` 打开（见 `Planner.tsx`）。
 */
export function DevBadge({
  fieldId,
  fieldState,
  label,
}: {
  readonly fieldId: PlannerFieldId;
  readonly fieldState: FieldState;
  readonly label: Record<FieldState, string>;
}): React.ReactElement {
  const spec = plannerField(fieldId);
  return (
    <dl className="planner-dev">
      <div>
        <dt>Field ID</dt>
        <dd>{spec.field_id}</dd>
      </div>
      <div>
        <dt>API Key</dt>
        <dd>planner_profile.{spec.api_key}</dd>
      </div>
      <div>
        <dt>Runtime Type</dt>
        <dd>{spec.runtime_type}</dd>
      </div>
      <div>
        <dt>Priority</dt>
        <dd>{spec.priority}</dd>
      </div>
      <div>
        <dt>Blocking</dt>
        <dd>{spec.blocking}</dd>
      </div>
      <div>
        <dt>Trigger Source</dt>
        <dd>{spec.trigger}</dd>
      </div>
      <div>
        <dt>Field State</dt>
        <dd>
          {fieldState} · {label[fieldState]}
        </dd>
      </div>
      {/*
       * 第八项不在规范的表里：这个字段有没有本地校验规则。
       * 加它的理由是 QA 报过的一类问题「填了非法值但没提示」有两种成因 ——
       * 校验没实现，与校验实现了但没触发。不显示这一项时两者无法区分。
       */}
      <div>
        <dt>Local Validator</dt>
        <dd>{hasValidator(fieldId) ? '有' : '无'}</dd>
      </div>
    </dl>
  );
}
