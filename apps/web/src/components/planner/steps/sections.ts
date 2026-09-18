import type { PlannerFieldId, PlannerStepId } from '@tps/schemas';

/**
 * 十个步骤的页面区块划分（规范各章的「页面区块顺序」）。
 *
 * ## 为什么这张表存在，而不是九个手写的 Step 组件
 *
 * `PLANNER_FIELDS` 的数组顺序**已经**是页面区块顺序（见 `planner-fields.ts`
 * 的文件头，已核对 10 个步骤）。九个 Step 组件如果各自再列一遍自己的字段，
 * 那就是把字段清单抄了第二遍 —— 而两份清单必然漂移，
 * 漂移的表现是「产品加了一个字段，某一步没有它」。
 *
 * 元数据表**没有**的东西只有一样：区块的小标题。规范每一章把一步里的
 * 若干问题分成 2～5 组并给了组名（「什么时候走」「过敏与安全」），
 * 而那是纯 UX 文案，不属于契约。因此这张表只声明「组名 + 这一组是哪几个字段」，
 * 渲染仍然交给通用渲染器。
 *
 * ## 每组必须是元数据数组里的**连续**一段
 *
 * 分组不得改变字段顺序 —— 规范给的是「页面区块顺序」，而重排会让
 * 「规范说先问日期，界面先问目的地」。因此 `sections.test.ts` 断言
 * 每一步的各组拼起来**逐个相等**于 `fieldsOfStep(step)`：
 * 顺序错、漏字段、多字段三种情况都会红。
 */

export interface PlannerSection {
  readonly title: string;
  /** 这一组为什么问。留空时不显示 —— 不是每组都需要一句解释 */
  readonly intro?: string;
  readonly fields: readonly PlannerFieldId[];
  /** 区块图标（可选）。图标名来自 `@tps/icon-library`，如 'map' / 'calendar' / 'flag' */
  readonly icon?: string;
  /** 区块图标颜色（可选）。8 色语义体系，参考 subtitle.html 设计稿 */
  readonly iconColor?:
    | 'blue'
    | 'green'
    | 'orange'
    | 'purple'
    | 'red'
    | 'cyan'
    | 'indigo'
    | 'gray';
  /** 相邻区块的布局组；相同组的连续卡片共享一个容器。 */
  readonly layoutGroup?: 'schedule' | 'preference';
}

export const STEP_SECTIONS: Record<PlannerStepId, readonly PlannerSection[]> = {
  /*
   * 第 0 步（入口页）没有契约字段，内容由 `Step0Entry` 组件承载。
   * 保留空数组是为了让 `Record<PlannerStepId, …>` 类型完整 ——
   * 缺这个键会在编译期报错，而不是运行期渲染一个空页面。
   */
  '00': [],
  '01': [
    {
      title: '从哪出发，去哪里',
      intro: '请选择至少 1 个目的地；有多个备选时可以按期望顺序添加，最多 5 个。',
      fields: ['PV2-01-001'],
      icon: 'map',
      iconColor: 'blue',
    },
    {
      title: '出发日期与返回日期',
      fields: ['PV2-01-004', 'PV2-01-005'],
      icon: 'calendar',
      iconColor: 'blue',
    },
    {
      title: '目的地 / 备选目的地',
      fields: ['PV2-01-003'],
      icon: 'map',
      iconColor: 'blue',
    },
    {
      title: '这趟旅行为了什么',
      fields: ['PV2-01-006', 'PV2-01-007'],
      icon: 'tips',
      iconColor: 'blue',
    },
    {
      title: '已经订好的部分',
      intro: '已购买且不可随意改动的部分会成为整份行程的锚点。',
      fields: ['PV2-01-008', 'PV2-01-009'],
      icon: 'ticket',
      iconColor: 'blue',
    },
  ],

  '02': [
    {
      title: '旅行人员',
      fields: ['PV2-02-001', 'PV2-02-002'],
      icon: 'users',
      iconColor: 'blue',
    },
    {
      title: '需要照顾的同行人',
      intro: '年龄是事实，行动能力是功能性约束 —— 我们不用年龄替代能力判断。',
      fields: ['PV2-02-003', 'PV2-02-004', 'PV2-02-005'],
      icon: 'shield',
      iconColor: 'red',
    },
    { title: '要不要分开', fields: ['PV2-02-006'], icon: 'users', iconColor: 'blue' },
  ],

  '03': [
    {
      title: '怎么表达预算最自然',
      fields: ['PV2-03-001', 'PV2-03-002'],
      icon: 'budget',
      iconColor: 'blue',
    },
    {
      title: '目标范围与硬上限',
      intro: '硬上限的优先级高于档次偏好 —— 它是不能超过的线。',
      fields: ['PV2-03-003', 'PV2-03-004', 'PV2-03-005'],
      icon: 'budget',
      iconColor: 'blue',
    },
    {
      title: '这笔钱包含什么，愿意多花在哪',
      fields: ['PV2-03-006'],
      icon: 'budget',
      iconColor: 'orange',
    },
  ],

  '04': [
    { title: '整体强度', fields: ['PV2-04-001'], icon: 'chart-bar', iconColor: 'purple' },
    {
      title: '一天怎么过',
      fields: ['PV2-04-002'],
      icon: 'clock',
      iconColor: 'cyan',
      layoutGroup: 'schedule',
    },
    {
      title: '每天可接受步行量',
      fields: ['PV2-04-003'],
      icon: 'walk',
      iconColor: 'blue',
      layoutGroup: 'schedule',
    },
    {
      title: '每天希望安排几个核心项目?',
      fields: ['PV2-04-004'],
      icon: 'star',
      iconColor: 'orange',
      layoutGroup: 'preference',
    },
    {
      title: '每天希望留多少自由时间?',
      fields: ['PV2-04-005'],
      icon: 'clock',
      iconColor: 'cyan',
      layoutGroup: 'preference',
    },
    {
      title: '最多愿意换几次住宿?',
      fields: ['PV2-04-007'],
      icon: 'luggage',
      iconColor: 'purple',
    },
    {
      title: '哪些方式你不能接受?',
      intro: '「明确不要」不会被我们主动安排，除非你之后放宽。',
      fields: ['PV2-04-008'],
      icon: 'ban',
      iconColor: 'red',
    },
  ],

  /*
   * 第 5 步的分组对齐 step5-design.png 参考稿：航班相关的三个字段
   * （002/003/004）在视觉上各成一张卡，字段标题就是那个问句
   * （「对直飞和转机有什么要求？」……），因此 002/004 的描述符带
   * `hide_question: true`；003 的问题恰好是「偏好舱等与座位」，与组名
   * 一字不差，保留字段标题不换文案 —— 契约问句不动。
   *
   * 「到了当地怎么移动」只含 005 —— 同选「自驾」后展开的 006 细节表单
   * 单列为「自驾计划详情」组，避免它挂在问句为「当地怎么移动」的卡里。
   */
  '05': [
    {
      title: '跨城怎么走',
      fields: ['PV2-05-001'],
      icon: 'bus',
      iconColor: 'green',
    },
    {
      title: '航班要求',
      /* 不填 intro：PV2-05-002 的 TRIGGER_REASON 文案与之一致，会显示在卡内 */
      fields: ['PV2-05-002'],
      icon: 'plane',
      iconColor: 'blue',
    },
    {
      title: '偏好舱等与座位',
      fields: ['PV2-05-003'],
      icon: 'seat',
      iconColor: 'cyan',
    },
    {
      title: '更喜欢什么时候出发/抵达？',
      fields: ['PV2-05-004'],
      icon: 'clock',
      iconColor: 'cyan',
    },
    {
      title: '到了当地怎么移动',
      fields: ['PV2-05-005'],
      icon: 'map-pin',
      iconColor: 'green',
    },
    {
      title: '自驾计划详情',
      fields: ['PV2-05-006'],
      icon: 'transport-drive',
      iconColor: 'blue',
    },
    { title: '行李', fields: ['PV2-05-007'], icon: 'luggage', iconColor: 'purple' },
  ],

  /*
   * 第 6 步的分组对齐 step6-design.png 参考稿：「睡眠和入住有什么硬要求？」
   * 独占一张卡（卡的标题就是问句），因此 PV2-06-008 的 check 部件不再带
   * label —— 与第 5 步 002/004 的 hide_question 同一思路，只是那里藏的是
   * 字段标题、这里省的是部件标签，契约问句都不动。
   */
  '06': [
    { title: '住什么类型', fields: ['PV2-06-001'], icon: 'hotel', iconColor: 'purple' },
    {
      title: '房间怎么配',
      intro: '房间配置需要能容纳全部旅行者，连通房需要供应商确认。',
      fields: ['PV2-06-002', 'PV2-06-003'],
      icon: 'bed',
      iconColor: 'purple',
    },
    {
      title: '每晚预算与位置取舍',
      fields: ['PV2-06-004', 'PV2-06-005'],
      icon: 'budget',
      iconColor: 'orange',
    },
    {
      title: '星级、设施与入住',
      intro: '住宿必须 / 偏好的设施',
      fields: ['PV2-06-006', 'PV2-06-007'],
      icon: 'star',
      iconColor: 'indigo',
    },
    {
      title: '睡眠和入住有什么硬要求？',
      fields: ['PV2-06-008'],
      icon: 'moon-stars',
      iconColor: 'purple',
    },
  ],

  '07': [
    {
      title: '想吃什么',
      fields: ['PV2-07-001', 'PV2-07-002'],
      icon: 'food',
      iconColor: 'green',
    },
    {
      title: '过敏与安全',
      intro: '过敏不用「偏好 / 必须 / 不要」表达 —— 它是安全硬约束。',
      fields: ['PV2-07-003', 'PV2-07-004'],
      icon: 'shield',
      iconColor: 'red',
    },
    { title: '怎么吃', fields: ['PV2-07-005'], icon: 'food', iconColor: 'green' },
    {
      title: '想玩什么',
      fields: ['PV2-07-006', 'PV2-07-007', 'PV2-07-008', 'PV2-07-009'],
      icon: 'camera',
      iconColor: 'blue',
    },
    { title: '购物与退税', fields: ['PV2-07-010'], icon: 'budget', iconColor: 'blue' },
  ],

  '08': [
    {
      title: '健康与无障碍',
      intro: '我们只问旅行中需要怎样的照顾，不收诊断信息。',
      fields: ['PV2-08-001', 'PV2-08-002'],
      icon: 'shield',
      iconColor: 'cyan',
    },
    {
      title: '高风险活动与随行药品',
      fields: ['PV2-08-003', 'PV2-08-004'],
      icon: 'alert',
      iconColor: 'red',
    },
    {
      title: '证件',
      intro: '只收状态与到期日，不收护照号、签证号或身份证号。',
      fields: ['PV2-08-005', 'PV2-08-006', 'PV2-08-007'],
      icon: 'ticket',
      iconColor: 'blue',
    },
    {
      title: '保险与安全阈值',
      fields: ['PV2-08-008', 'PV2-08-009'],
      icon: 'shield',
      iconColor: 'red',
    },
    {
      title: '不能移动的工作安排',
      fields: ['PV2-08-010'],
      icon: 'briefcase',
      iconColor: 'blue',
    },
  ],

  '09': [
    {
      title: '这是我们理解的你',
      intro: '逐组确认即可，有问题可以直接点回原来那一步修改。',
      fields: ['PV2-09-001', 'PV2-09-002'],
      icon: 'flag',
      iconColor: 'blue',
    },
    {
      title: '希望我们怎么提醒你',
      fields: ['PV2-09-003', 'PV2-09-004'],
      icon: 'clock',
      iconColor: 'blue',
    },
    {
      title: '信息使用授权',
      intro: '两项授权是分开的：一项用于本次服务，一项用于将来免于重填。',
      fields: ['PV2-09-005', 'PV2-09-006'],
      icon: 'shield',
      iconColor: 'blue',
    },
  ],

  '10': [
    {
      title: '联网与支付',
      fields: ['PV2-10-001', 'PV2-10-002'],
      icon: 'budget',
      iconColor: 'blue',
    },
    {
      title: '会员权益与紧急联系人',
      fields: ['PV2-10-003', 'PV2-10-004'],
      icon: 'star',
      iconColor: 'blue',
    },
    {
      title: '文件与旅中监控',
      fields: ['PV2-10-005', 'PV2-10-006'],
      icon: 'shield',
      iconColor: 'blue',
    },
  ],
};
