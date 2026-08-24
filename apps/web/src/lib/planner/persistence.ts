import { PLANNER_STEP_IDS, type PlannerFieldId, type PlannerStepId } from '@tps/schemas';

import { INITIAL_PLANNER_STATE, type PlannerState } from './state';

/**
 * 草稿持久化（规范 6 的「自动保存」与附录 C 的「草稿恢复」）。
 *
 * ## 为什么必须是真的持久化
 *
 * 附录 C 把「草稿保存是真实持久化并可恢复，不只是『已保存』视觉文案」列为
 * P0 验收项。九步问卷在复杂场景下要填 10–15 分钟，而误触刷新之后从头再来
 * 是这个产品最容易被放弃的一个点。
 *
 * ## 为什么带 schema 版本号
 *
 * 存的是 `planner_profile` 形状的答案树。契约演进（枚举值改名、字段挪块）之后
 * 旧草稿的形状不再匹配，而**恢复一份形状错误的草稿比丢弃它更糟** ——
 * 界面会渲染出一堆看不懂的空控件，用户不知道该重填还是该等。
 * 版本不匹配时直接丢弃并当作新草稿。
 *
 * ## 跨设备恢复不在本轮
 *
 * 规范 6 提到「登录后支持跨设备恢复」，那需要服务端草稿表。本轮只做
 * localStorage（刷新/关闭可恢复），见实施计划的「明确不在本轮范围」。
 */

const STORAGE_KEY = 'tps.planner.v2.draft';

/**
 * 草稿结构版本。**改答案树的形状就要 +1。**
 *
 * 与契约的 `schema_version` 分开：契约版本管的是「发出去的请求长什么样」，
 * 这个管的是「浏览器里存的草稿长什么样」。前者不因加可选字段而递增，
 * 而后者在枚举值改名时就必须递增 —— 两者的变更节奏不同。
 */
const DRAFT_VERSION = 1;

interface StoredDraft {
  readonly version: number;
  readonly savedAt: string;
  readonly answers: unknown;
  readonly touched: readonly string[];
  readonly optIns: readonly string[];
  readonly activeStep: string;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * 写草稿。返回是否成功 —— 失败**不阻断编辑**但要能重试（规范 6）。
 *
 * 失败的现实原因是 localStorage 满了或被隐私模式禁用，两者都不该让用户
 * 无法继续填表；而静默失败会让「已保存」变成一句谎话。
 */
export function saveDraft(state: PlannerState, now: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  const draft: StoredDraft = {
    version: DRAFT_VERSION,
    savedAt: now,
    answers: state.answers,
    touched: state.touched,
    optIns: state.optIns,
    activeStep: state.activeStep,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读草稿。读不到或版本不匹配时返回 null。
 *
 * `devMode` 不进草稿：它是调试开关，跨会话保留会让开发环境的截图里
 * 莫名出现 Field ID，而生产端本来就该隐藏它。
 */
export function loadDraft(): PlannerState | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const draft = parsed as Partial<StoredDraft>;
  if (draft.version !== DRAFT_VERSION) return null;
  if (typeof draft.answers !== 'object' || draft.answers === null) return null;

  /*
   * 两处 `as`：从 JSON 读回来的 `touched` / `optIns` 静态上是 `unknown[]`，
   * 而它们的元素是 76 个字面量的联合。
   *
   * 不在这里跑一遍 `PlannerProfileSchema.safeParse`：那会把「一个枚举值改了名」
   * 从「那一项失效」升级成「整份草稿作废」，而用户填的其余 70 个字段是好的。
   * 形状错误的单个字段由控件自己兜住（读不出值就显示未选），
   * 而整体形状错误由上面的版本号拦住。
   *
   * `answers` 不需要断言：它已被上面的 `typeof !== 'object'` 收窄，
   * 而 `PlannerProfileInput` 的每个键都可缺省，因此 `object` 直接可赋。
   */
  const steps: readonly string[] = PLANNER_STEP_IDS;
  const activeStep =
    typeof draft.activeStep === 'string' && steps.includes(draft.activeStep)
      ? (draft.activeStep as PlannerStepId)
      : '01';

  return {
    ...INITIAL_PLANNER_STATE,
    answers: draft.answers,
    touched: (Array.isArray(draft.touched) ? draft.touched : []) as readonly PlannerFieldId[],
    optIns: (Array.isArray(draft.optIns) ? draft.optIns : []) as readonly PlannerFieldId[],
    activeStep,
  };
}

export function clearDraft(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 清不掉也不该抛：调用它的地方是「重新开始」，那时用户已经决定放弃这份草稿 */
  }
}

export const SAVE_STATE_LABEL: Record<SaveState, string> = {
  idle: '修改会自动保存',
  saving: '正在保存',
  saved: '已自动保存',
  failed: '保存失败，点击重试',
};
