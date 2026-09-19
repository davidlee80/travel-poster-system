import type { PlannerFieldId, PlannerStepId } from '@tps/schemas';

import type { PlannerSection } from '@/components/planner/steps/sections';
import { STEP_SECTIONS } from '@/components/planner/steps/sections';

import type { RouteFieldId } from './route-fields';
import type { EntryRoute } from './state';

/**
 * 路线内容表的区块。与 `PlannerSection` 同形，唯一区别是字段清单
 * 允许混入占位字段（`RT-*`）。
 *
 * 为什么不让 `PlannerSection.fields` 直接放宽成 `string`：那张表是
 * 76 字段契约的镜像，`sections.test.tsx` 断言它与元数据表逐个相等 ——
 * 放宽之后「表里写了一个契约里不存在的字段名」就从编译错误退化成
 * 运行期静默少一块。占位字段只出现在这张表里，因此宽化只发生在这里。
 */
export type RouteSection = Omit<PlannerSection, 'fields'> & {
  readonly fields: readonly (PlannerFieldId | RouteFieldId)[];
};

/**
 * 入口路线 → 第 1 步完整内容（区块表 + 页头文案）。
 *
 * ## 为什么这是一张表而不是组件里的 if
 *
 * 第 0 步选卡会改变第 1 步**显示什么**，而需求方已明确「区块差异会随
 * 需求频繁变化」。把规则集中在一张表里，是为了让下一次调整只改数据、
 * 不动 `StepPage` 的渲染分支 —— 四个 if 散在组件里，第五次需求来时
 * 就要重读整个组件。
 *
 * ## 字段分两类，渲染管线是同一条
 *
 *   - 契约字段（`PV2-*`）：与 plan 路线共用同一份答案键（如
 *     `PV2-01-001` 的 `trip.origin`）—— 用户在 explore 填的出发地，
 *     切到 plan 还在，右栏摘要也照常工作；
 *   - 占位字段（`RT-*`）：路线专属问题（设计稿里有、契约里没有的），
 *     注册在 `route-fields.ts`，值进 `answers.route_<route>` 隔离块，
 *     提交前剔除。稳定后好的问题会「转正」为契约字段。
 *
 * ## 去重原则（用户确认）
 *
 * 设计稿（design/new/01|02|03.html）中与第 2–9 步问卷重复的问题
 * （预算、同行人数等）**舍弃**，由各路线第 1 步只问「这一步独有的事」，
 * 其余交给后续步骤。
 *
 * ## TODO（后端契约重梳理时处理）
 *
 * 被替换掉的契约字段仍按原契约参与必填/阻塞计算；本表只做**视觉过滤**，
 * 不解除阻塞。等后端契约重梳理时，需要把「该路线下哪些字段不再是
 * 必填/阻塞」下沉为正式契约规则，前端再改为读取契约而不是这张表。
 */

/** 一条路线在第 1 步的完整内容：页头文案 + 区块表 */
export interface Step1Content {
  readonly head: {
    /** 覆盖 `PLANNER_STEPS['01']` 的 title（路线专属问句） */
    readonly title: string;
    /** 覆盖 intro（路线导语）；缺省时沿用契约元数据 */
    readonly intro?: string;
  };
  /**
   * 区块表。字段是契约字段（`PV2-*`）与占位字段（`RT-*`）的混排，
   * 渲染管线相同。
   */
  readonly sections: readonly RouteSection[];
}

/**
 * 每条路线的第 1 步内容。
 *
 * `plan`（都定了）为 `undefined` —— 那条路线的语义是「信息已齐，
 * 只差串起来」，显示 `STEP_SECTIONS['01']` 全量五区块（现状）。
 * 用 `undefined` 表达而不是把五区块抄进表：抄一份之后契约侧改分组，
 * 这里就会静默漂移。
 */
export const STEP1_CONTENT_BY_ROUTE: Readonly<
  Record<EntryRoute, Step1Content | undefined>
> = {
  /* 还没想好去哪（design/new/01.html）：不问目的地与日期，先问方向 */
  explore: {
    head: {
      title: '先不决定去哪，想想你想怎样度过这几天',
      intro: '一点期待，就足够开始。不用确定日期，也不用先有目的地。',
    },
    sections: [
      { title: '从哪里出发', fields: ['PV2-01-001'], icon: 'map', iconColor: 'blue' },
      {
        title: '这次最想获得什么',
        intro: '可多选，不选也可以。',
        fields: ['RT-EXP-01'],
        icon: 'tips',
        iconColor: 'purple',
      },
      { title: '大概能玩多久', fields: ['RT-EXP-02'], icon: 'clock', iconColor: 'cyan' },
    ],
  },

  /* 假期有了（design/new/02.html）：缺的是目的地，先框定假期的边界 */
  destination: {
    head: {
      title: '假期留出来了，把它交给一个值得去的地方',
      intro: '先框定这段假期的边界，我们再一起看看哪些地方合适。',
    },
    sections: [
      { title: '从哪里出发', fields: ['PV2-01-001'], icon: 'map', iconColor: 'blue' },
      {
        title: '这段假期是什么时候',
        fields: ['PV2-01-005', 'PV2-01-004', 'RT-DST-01'],
        icon: 'calendar',
        iconColor: 'blue',
      },
      { title: '单程交通最多多久', fields: ['RT-DST-02'], icon: 'clock', iconColor: 'cyan' },
      {
        title: '这趟旅行为了什么',
        fields: ['PV2-01-006', 'PV2-01-007'],
        icon: 'tips',
        iconColor: 'blue',
      },
    ],
  },

  /* 有想去的地方（design/new/03.html）：缺的是时间，先框一个出行窗口 */
  time: {
    head: {
      title: '心里已经有了远方，再为它留一段合适的时间',
      intro: '目的地已经确定，我们来框一个合适的出行窗口。',
    },
    sections: [
      {
        title: '想去哪里',
        intro: '顺序即行程顺序，最多 5 个。',
        fields: ['PV2-01-003'],
        icon: 'map',
        iconColor: 'blue',
      },
      { title: '从哪里出发', fields: ['PV2-01-001'], icon: 'map', iconColor: 'blue' },
      { title: '可以考虑哪些时间', fields: ['RT-TIM-01'], icon: 'calendar', iconColor: 'blue' },
      { title: '大概玩几天', fields: ['RT-TIM-02'], icon: 'clock', iconColor: 'cyan' },
      {
        title: '有没有特别想体验的',
        fields: ['RT-TIM-03'],
        icon: 'tips',
        iconColor: 'purple',
      },
      { title: '时间没定，主要在等什么', fields: ['RT-TIM-04'], icon: 'tips', iconColor: 'blue' },
    ],
  },

  /* 都定了：全量展示（undefined = 回落 STEP_SECTIONS['01'] 现状） */
  plan: undefined,
};

/**
 * 第 1 步应当渲染的区块表。
 *
 * `plan` 路线与「还没选路线」都回落到契约区块表 —— 后者是兜底
 * （用户从别处直接跳到第 1 步），不是常态。
 */
export function step1Sections(route: EntryRoute | null): readonly RouteSection[] {
  const content = route === null ? undefined : STEP1_CONTENT_BY_ROUTE[route];
  return content?.sections ?? STEP_SECTIONS['01'];
}

/** 第 1 步的页头覆盖；`null` 表示沿用契约元数据（plan / 未选路线） */
export function step1Head(route: EntryRoute | null): Step1Content['head'] | null {
  if (route === null) return null;
  return STEP1_CONTENT_BY_ROUTE[route]?.head ?? null;
}

/** 供 UI 展示用的路线标签（第 0 步卡片标题） */
export const ENTRY_ROUTE_LABEL: Record<EntryRoute, string> = {
  explore: '还没想好去哪',
  destination: '假期有了，去哪好呢',
  time: '有想去的地方，时间待定',
  plan: '都定了，开始规划吧',
};

/**
 * 判断某个步骤是否受入口路线影响（目前只有第 1 步）。
 *
 * 单独抽出来而不是在 StepPage 里写 `step === '01'`：将来若第 2、3 步
 * 也按路线分版，只需在这里加映射，StepPage 的调用点不变。
 */
export function routeAffectsStep(step: PlannerStepId): boolean {
  return step === '01';
}
