import {
  PLANNER_FIELDS,
  plannerField,
  type PlannerFieldId,
  type PlannerProfileInput,
  type PlannerStepId,
} from '@tps/schemas';

/**
 * Planner V2.1 的答案存储与 reducer。
 *
 * ## 为什么答案是**嵌套**的而不是 `Record<api_key, unknown>`
 *
 * 扁平表对「按字段遍历」的机制（触发引擎、状态机、校验、摘要、Dev Mode 五处）
 * 更友好，但它会把 76 个字段的值类型全部退化成 `unknown` —— 于是每个步骤组件
 * 里都要写一次断言，而断言写错在界面上看不出来（一个 enum 被当成数组读，
 * 表现是那个选项永远不高亮）。
 *
 * 因此存储用契约的嵌套形状（`PlannerProfileInput`，编译期逐字段有类型），
 * 另给需要遍历的机制一个通用读取器 `readAnswer` —— 一处受控的断言换掉
 * 76 处分散的断言。提交时 `answers` 几乎可以直接作为 `planner_profile` 发出。
 *
 * ## 为什么 patch 里带 fieldId
 *
 * 规范要求每个字段有独立的 dirty / validation / field state（3.3），而
 * 「哪个字段被改了」无法从 patch 的形状反推。带上 fieldId 让 touched 记账与
 * 后续埋点都拿到确定答案，而不用依赖答案块的形状猜测交互来源。
 */

// ── 状态 ────────────────────────────────────────────────────

/**
 * 一次答案更新。按块浅合并 —— patch 的目标总是叶子键，
 * 因此块级浅合并已经足够，不需要引入深合并（深合并会让「把数组清空」
 * 与「不改这个数组」难以区分）。
 */
export type PlannerAnswerPatch = {
  readonly [B in keyof PlannerProfileInput]?: Partial<NonNullable<PlannerProfileInput[B]>>;
};

export interface PlannerState {
  /** 76 字段的答案。形状与契约的 `planner_profile` 逐字相同 */
  readonly answers: PlannerProfileInput;
  /**
   * 用户主动编辑过的字段。
   *
   * 与「有值」不同：默认值（节奏 3 档、人数 1 人）在字段上与用户填出同样的值
   * 无法区分，而规范 6 要求「非阻塞可选字段留空不显示红色错误」——
   * 判断「留空」需要知道用户到底碰过没碰。
   */
  readonly touched: readonly PlannerFieldId[];
  /**
   * 用户主动展开的分支。
   *
   * 字段表里有四个字段的触发条件写着「或用户主动开启」（午休、购物、
   * 工作安排、会员权益）。它们不由上游答案决定，只能显式记账。
   */
  readonly optIns: readonly PlannerFieldId[];
  /** 当前步骤。分页显示，一次只渲染一个 */
  readonly activeStep: PlannerStepId;
  /** Dev Mode：显示 Field ID / API Key / 运行时类型 / 触发来源（规范 21.1） */
  readonly devMode: boolean;
}

export const INITIAL_PLANNER_STATE: PlannerState = {
  answers: {},
  touched: [],
  optIns: [],
  activeStep: '01',
  devMode: false,
};

// ── 通用读取 ────────────────────────────────────────────────

/**
 * 按 api_key 取值。
 *
 * `as Record<string, unknown>`：`PlannerProfileInput` 的键是 19 个字面量，
 * 而这里的 `block` 是运行期字符串（来自元数据表）。断言之下立刻用
 * `typeof === 'object'` 兜住 —— 元数据表与契约的一致性由
 * `planner-profile.test.ts` 的双向断言保证，因此这条路径上取不到值
 * 只可能是两者不同步，而那已经在 CI 里红了。
 */
export function readAnswer(answers: PlannerProfileInput, apiKey: string): unknown {
  const dot = apiKey.indexOf('.');
  if (dot < 0) return undefined;
  const block = (answers as Record<string, unknown>)[apiKey.slice(0, dot)];
  if (typeof block !== 'object' || block === null) return undefined;
  return (block as Record<string, unknown>)[apiKey.slice(dot + 1)];
}

/**
 * 这个值算不算「已回答」。
 *
 * 逐形状处理而不是 `value !== undefined`：契约里有五种包装形状，
 * 而它们的空值长得都不一样。判错的后果分两种，都不报错：
 * 把空当成有值 → 完成度虚高、blocker 校验放过缺失项；
 * 把有值当成空 → 用户填完了界面还说「未回答」。
 *
 *   - 多选带「其他」：`{ values: [], other_text: undefined }` 是空
 *   - 开关型：`{ enabled: false }` **不是**空 —— 用户明确关掉了它
 *   - 自报型：`{ user_reported: undefined }` 是空，要递归进去看
 *   - 普通对象：任一叶子有值就算有值
 */
export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if ('enabled' in record) return true;
  if ('user_reported' in record) return hasValue(record['user_reported']);
  if ('values' in record) {
    return hasValue(record['values']) || hasValue(record['other_text']);
  }
  return Object.values(record).some((entry) => hasValue(entry));
}

/** 这个字段有没有答案 */
export function isAnswered(state: PlannerState, fieldId: PlannerFieldId): boolean {
  return hasValue(readAnswer(state.answers, plannerField(fieldId).api_key));
}

export function isTouched(state: PlannerState, fieldId: PlannerFieldId): boolean {
  return state.touched.includes(fieldId);
}

export function isOptedIn(state: PlannerState, fieldId: PlannerFieldId): boolean {
  return state.optIns.includes(fieldId);
}

// ── Action ──────────────────────────────────────────────────

export type PlannerAction =
  /** 写入答案。`fieldId` 决定 touched 记账归属 */
  | {
      readonly type: 'answer';
      readonly fieldId: PlannerFieldId;
      readonly patch: PlannerAnswerPatch;
    }
  /** 用户主动展开/收起一个「或用户主动开启」的分支 */
  | { readonly type: 'toggleOptIn'; readonly fieldId: PlannerFieldId }
  | { readonly type: 'goToStep'; readonly step: PlannerStepId }
  | { readonly type: 'setDevMode'; readonly on: boolean }
  /** 草稿恢复。整体替换而不是逐字段回放 —— 回放会让 touched 记账失真 */
  | { readonly type: 'restore'; readonly state: PlannerState }
  | { readonly type: 'reset' };

function mergeAnswers(
  answers: PlannerProfileInput,
  patch: PlannerAnswerPatch,
): PlannerProfileInput {
  const next: Record<string, unknown> = { ...answers };
  for (const [block, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = next[block];
    next[block] =
      typeof current === 'object' && current !== null ? { ...current, ...value } : { ...value };
  }
  /*
   * 不需要断言：`PlannerProfileInput` 的每个键都可缺省，
   * 因此 `Record<string, unknown>` 直接可赋。逐块浅合并的**内容**正确性
   * 由 patch 的类型保证（每个块的键只能是该块的键）。
   */
  return next;
}

function withTouched(
  touched: readonly PlannerFieldId[],
  fieldId: PlannerFieldId,
): readonly PlannerFieldId[] {
  return touched.includes(fieldId) ? touched : [...touched, fieldId];
}

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  switch (action.type) {
    case 'answer':
      return {
        ...state,
        answers: mergeAnswers(state.answers, action.patch),
        touched: withTouched(state.touched, action.fieldId),
      };

    case 'toggleOptIn': {
      const on = state.optIns.includes(action.fieldId);
      return {
        ...state,
        /*
         * 收起分支**不清值**（规范 6 的「值保留」）：草稿留着，字段变成
         * inactive。真正清除只在用户显式删除记录、选了互斥的「无」、
         * 确认重置时发生 —— 收起一个折叠面板不属于这几种。
         */
        optIns: on
          ? state.optIns.filter((entry) => entry !== action.fieldId)
          : [...state.optIns, action.fieldId],
      };
    }

    case 'goToStep':
      return { ...state, activeStep: action.step };

    case 'setDevMode':
      return { ...state, devMode: action.on };

    case 'restore':
      return action.state;

    case 'reset':
      return INITIAL_PLANNER_STATE;

    default: {
      /*
       * 穷尽性检查：漏一个分支是编译错误而不是「点了没反应」，
       * 后者在九步问卷里极难定位 —— 用户会以为自己没点中。
       */
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

// ── 便捷查询 ────────────────────────────────────────────────

/**
 * 该步骤的字段元数据，按页面区块顺序。
 *
 * **刻意不写返回类型注解。** 写成 `readonly PlannerFieldSpec[]` 会把
 * `field_id` 从 76 个字面量的联合退化成 `string`（接口里它声明为 string），
 * 于是调用方拿它去查 `Map<PlannerFieldId, …>` 时全都要断言一次 ——
 * 而那些断言会掩盖真正的拼写错误。让它从 `PLANNER_FIELDS` 推导，
 * 字面量类型就一路传下去。
 */
export function fieldsOfStep(step: PlannerStepId) {
  return PLANNER_FIELDS.filter((field) => field.step === step);
}

/** 全部 field_id，按页面区块顺序。遍历型机制用它 */
export const ALL_FIELD_IDS: readonly PlannerFieldId[] = PLANNER_FIELDS.map(
  (field) => field.field_id,
);
