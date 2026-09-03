import { z } from 'zod';

/**
 * 76 个产品字段的元数据（Planner V2.1，`docs/design/Planner_V2_产品字段表.xlsx`
 * 与《Planner V2.1 页面交互规范》附录 A）。
 *
 * ## 为什么放在 schemas 包而不是 apps/web
 *
 * 规范 21.1 的硬门槛是「V2.1 必须能识别 76 个唯一 Field ID」，而 21.2 要求
 * 生成结果保存 `source_field_id` 使推荐可追溯。也就是说**后端**也要按
 * field_id 溯源，而不只是前端渲染需要它。放在 apps/web 会让后端再抄一份，
 * 而两份必然漂移 —— 漂移的表现是「推荐解释指向一个不存在的字段」。
 *
 * ## 这张表是转录而不是再设计
 *
 * 每一列都对应字段表/附录 A 的一列，逐字转录：
 *
 * | 本文件            | 来源                                        |
 * | ----------------- | ------------------------------------------- |
 * | `field_id`        | 字段表「字段ID」                            |
 * | `step`            | 字段表「步骤」                              |
 * | `api_key`         | 字段表「API Key」                           |
 * | `level`           | 字段表「字段层级」                          |
 * | `runtime_type`    | **附录 A「运行时类型」**（不是字段表「条件类型」） |
 * | `priority`        | 字段表「优先级」                            |
 * | `required`        | 字段表「必填规则」                          |
 * | `blocking`        | 字段表「阻塞初步方案」                      |
 * | `summary_group`   | 字段表「右侧摘要分组」                      |
 * | `sensitivity`     | 字段表「敏感级别」                          |
 * | `data_type`       | 字段表「数据类型」                          |
 * | `question`        | 字段表「客户问题/字段」                     |
 * | `control`         | 字段表「推荐控件」                          |
 * | `trigger`         | 字段表「显示/触发条件」                     |
 * | `validation`      | 字段表「校验/验收规则」                     |
 *
 * `runtime_type` 取附录 A 而不是字段表：规范 0 章把 VERIFY 拆成了
 * BLOCKING / NONBLOCKING 两级，而字段表那一列还是合并的 `VERIFY`。
 * 「签证待查」与「严重过敏安全确认」拥有同样的风险语义是 V2.0 的缺陷，
 * V2.1 修掉了它，因此以附录 A 为准。
 *
 * ## 数组顺序 = 页面区块顺序
 *
 * 规范每一章都给了「页面区块顺序」，而它与字段表的行序逐条一致（已核对
 * 10 个步骤）。因此界面按本数组顺序渲染即符合规范，不需要第二张顺序表 ——
 * 两张表必然漂移，而漂移的表现是「规范说先问日期，界面先问目的地」。
 *
 * ## LOCKED 不在 `runtime_type` 里
 *
 * 规范 4 章把 LOCKED 列为条件类型，但同章的注写明「LOCKED 是运行时条件
 * 类型，不要求修改产品字段表的条件类型列 —— 由 trip.locked_order_types /
 * trip.locked_orders 的有效记录派生」。因此它属于
 * `PLANNER_CONSTRAINT_TYPE_VALUES`（运行时）而不是字段的静态类型。
 * `PV2-01-009` 在附录 A 里是 `HARD`，这不是笔误。
 */

/** 9 步主问卷 + 生成后的行前准备中心。字符串而不是数字 —— 它同时是 field_id 的第二段 */
export const PLANNER_STEP_IDS = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
] as const;
export type PlannerStepId = (typeof PLANNER_STEP_IDS)[number];

/** 字段层级（规范 2.2）。`POST_PLAN` 不参与首次生成的完成度与 blocker */
export const PLANNER_FIELD_LEVEL_VALUES = ['MAIN', 'CONDITIONAL', 'POST_PLAN'] as const;
export type PlannerFieldLevel = (typeof PLANNER_FIELD_LEVEL_VALUES)[number];

/**
 * 字段的运行时类型（规范 4 章，经 0 章的 VERIFY 分级修订）。
 *
 * `PREFER_EXCLUDE` 只有 `PV2-07-009`（想去/不要去）一个 —— 它是一个双列表
 * 控件，左列进 PREFER、右列进 EXCLUDE。不拆成两个 field_id 是因为字段表
 * 给了它一个 API Key（`interests.wish_and_exclude`），而 76 这个数字是硬门槛。
 */
export const PLANNER_RUNTIME_TYPE_VALUES = [
  'FACT',
  'HARD',
  'PREFER',
  'EXCLUDE',
  'PREFER_EXCLUDE',
  'VERIFY_BLOCKING',
  'VERIFY_NONBLOCKING',
  'CONSENT',
  'INFO',
] as const;
export type PlannerRuntimeType = (typeof PLANNER_RUNTIME_TYPE_VALUES)[number];

/** 必填规则。`CONDITIONAL` = 触发条件成立时必填 */
export const PLANNER_REQUIREMENT_VALUES = ['ALWAYS', 'CONDITIONAL', 'OPTIONAL'] as const;
export type PlannerRequirement = (typeof PLANNER_REQUIREMENT_VALUES)[number];

/**
 * 是否阻塞初步方案。
 *
 * 与 `required` 正交：`PV2-01-005`（日期弹性）是 `ALWAYS` 必填但 `NEVER` 阻塞，
 * 而 `PV2-03-005`（硬上限）是 `OPTIONAL` 但 `CONDITIONAL` 阻塞（开了开关就得填数）。
 * 把两者合成一个字段会让这两类字段之一被错误处理，而症状是「明明能生成却被拦住」
 * 或者更糟的「缺关键条件却静默生成」。
 */
export const PLANNER_BLOCKING_VALUES = ['ALWAYS', 'CONDITIONAL', 'NEVER'] as const;
export type PlannerBlocking = (typeof PLANNER_BLOCKING_VALUES)[number];

/** 右侧旅行画像的五组 + 不展示（规范 17）。`HIDDEN` 用于授权与自由文本 */
export const PLANNER_SUMMARY_GROUP_VALUES = [
  'SKELETON',
  'MUST',
  'PREFER',
  'EXCLUDE',
  'VERIFY',
  'HIDDEN',
] as const;
export type PlannerSummaryGroup = (typeof PLANNER_SUMMARY_GROUP_VALUES)[number];

/**
 * 敏感级别（规范 20）。
 *
 * `HIGH` 的字段在右侧只显示抽象摘要（如「存在严重食物过敏需求」），
 * 不显示具体值 —— 这条规则的实现要读这一列，因此它必须在元数据里。
 */
export const PLANNER_SENSITIVITY_VALUES = ['NORMAL', 'MEDIUM', 'SENSITIVE', 'HIGH'] as const;
export type PlannerSensitivity = (typeof PLANNER_SENSITIVITY_VALUES)[number];

export const PLANNER_PRIORITY_VALUES = ['P0', 'P1', 'P2'] as const;
export type PlannerPriority = (typeof PLANNER_PRIORITY_VALUES)[number];

/**
 * 运行时约束类型（规范 4 章 + 4.1）。
 *
 * 比 `PLANNER_RUNTIME_TYPE_VALUES` 多一个 `LOCKED`、少一个 `PREFER_EXCLUDE`：
 * 前者由已有订单派生（见本文件头），后者在派生时按左右列拆成 PREFER 与 EXCLUDE
 * 两条约束 —— 一条运行时约束不可能同时是「优先」和「排除」。
 */
export const PLANNER_CONSTRAINT_TYPE_VALUES = [
  'LOCKED',
  'CONSENT',
  'HARD',
  'EXCLUDE',
  'VERIFY_BLOCKING',
  'VERIFY_NONBLOCKING',
  'PREFER',
  'FACT',
  'INFO',
] as const;
export type PlannerConstraintType = (typeof PLANNER_CONSTRAINT_TYPE_VALUES)[number];

/**
 * 运行时约束类型的 Zod schema。
 *
 * 定义在这里而不是在唯一的消费方（`travel-request.ts` 的 `RuntimeConstraint`）：
 * 取值数组在本文件，两处分开会让下一个加类型的人只改了数组 ——
 * 而那时 schema 会拒掉一个刚加进来的合法类型，错误是 `REQ_SCHEMA_INVALID`。
 *
 * 这是本文件唯一用到 zod 的地方。其余部分刻意保持为纯元数据 ——
 * 它被前端逐字段遍历，不该拖进一个校验库的运行时。
 */
export const PlannerConstraintTypeSchema = z.enum(PLANNER_CONSTRAINT_TYPE_VALUES);

/**
 * 4.1 的运行时优先级：`LOCKED > CONSENT/安全硬约束 > HARD > EXCLUDE > VERIFY > PREFER`。
 *
 * **数字小 = 优先级高**，低优先级不得静默覆盖高优先级。写成 `Record` 而不是
 * 有序数组：冲突处理要按类型查权重（`precedence[a] < precedence[b]`），
 * 而数组每次都得 `indexOf` —— 且新增类型时漏加会静默得到 -1，也就是「最高优先级」。
 *
 * `FACT` 与 `INFO` 排在最后：它们不是约束，不参与取舍。给它们一个显式的最低
 * 权重而不是留空，是为了让 `Record` 的穷尽性在新增类型时报编译错误。
 */
export const PLANNER_CONSTRAINT_PRECEDENCE: Record<PlannerConstraintType, number> = {
  LOCKED: 0,
  CONSENT: 1,
  HARD: 2,
  EXCLUDE: 3,
  VERIFY_BLOCKING: 4,
  VERIFY_NONBLOCKING: 5,
  PREFER: 6,
  FACT: 7,
  INFO: 8,
};

/** 一个产品字段的全部元数据。逐列来源见本文件头的对照表 */
export interface PlannerFieldSpec {
  readonly field_id: string;
  readonly step: PlannerStepId;
  readonly api_key: string;
  readonly level: PlannerFieldLevel;
  readonly runtime_type: PlannerRuntimeType;
  readonly priority: PlannerPriority;
  readonly required: PlannerRequirement;
  readonly blocking: PlannerBlocking;
  readonly summary_group: PlannerSummaryGroup;
  readonly sensitivity: PlannerSensitivity;
  /** 字段表原文（`object` / `array<stance>` / `ranked_array` …）。前端据此选控件族 */
  readonly data_type: string;
  readonly question: string;
  readonly control: string;
  /** 人类可读的触发条件原文。可执行的触发逻辑在前端 `lib/planner/triggers.ts` */
  readonly trigger: string;
  readonly validation: string;
}

/**
 * 三级命名体系（规范 2.1）。
 *
 * 三个名字各有各的稳定性：`nav` 与 `title` 属于 UX 文案层，可在不改语义的
 * 前提下迭代；`module` 是内部稳定模块名，与 field_id、API Key、埋点 ID 一样
 * **不随营销或文案修改而变化**。分开存是这条规则的唯一实现方式 ——
 * 只存一个名字的话，改一次导航文案就会同时改掉埋点的分组键。
 */
export interface PlannerStepSpec {
  readonly step: PlannerStepId;
  /** 导航短名称。左栏用 */
  readonly nav: string;
  /** 页面对话式标题。主栏 header 用 */
  readonly title: string;
  /** 内部稳定模块名。埋点与日志用，不上屏 */
  readonly module: string;
  /** 主栏 header 的一句话解释 */
  readonly intro: string;
}

export const PLANNER_STEPS = [
  {
    step: '01',
    nav: '旅行轮廓',
    title: '先勾勒这趟旅行的轮廓',
    module: '这次想怎么旅行',
    intro: '建立旅行骨架和成功标准，并决定后续跨境、日期与订单分支。',
  },
  {
    step: '02',
    nav: '旅行人员',
    title: '这次旅行都有谁？',
    module: '谁一起旅行',
    intro: '包括你自己在内，按年龄段添加所有旅行人员；行动能力仍由你单独判断。',
  },
  {
    step: '03',
    nav: '预算取舍',
    title: '这趟旅行，钱想怎么花？',
    module: '准备花多少钱',
    intro: '用最自然的方式表达预算，并区分目标范围、预算口径和绝对不能超过的硬上限。',
  },
  {
    step: '04',
    nav: '旅行节奏',
    title: '一天怎么过，才像你的旅行？',
    module: '旅行节奏与边界',
    intro: '把强度、作息、步行、自由时间、换酒店容忍度和风险边界转换成可执行条件。',
  },
  {
    step: '05',
    nav: '路上怎么走',
    title: '路上怎么走，更轻松？',
    module: '怎么去、怎么移动',
    intro: '跨城交通、航班约束、当地交通和自驾分开处理，深层问题只在对应方式存在时出现。',
  },
  {
    step: '06',
    nav: '住得更舒服',
    title: '住在哪里，才真正舒服？',
    module: '想住什么样',
    intro: '把住宿从类型偏好升级为房间配置、位置取舍和设施硬约束。',
  },
  {
    step: '07',
    nav: '吃好也玩好',
    title: '想吃什么，也想怎么玩？',
    module: '想吃什么、玩什么',
    intro: '餐饮偏好、饮食硬约束、过敏安全、兴趣 Top 3、必去清单与明确不要分开处理。',
  },
  {
    step: '08',
    nav: '特别关照',
    title: '有哪些事，需要我们多照顾一点？',
    module: '需要特别照顾什么',
    intro: '以最小信息原则采集健康、证件、高风险活动与安全需求，不收证件号码或医学诊断。',
  },
  {
    step: '09',
    nav: '确认旅程',
    title: '这是我们理解的你',
    module: '确认你的旅行画像',
    intro: '不重复问卷，而是确认理解、集中解决待补充项、查看系统核验状态、完成授权并进入生成。',
  },
  {
    step: '10',
    nav: '行前准备中心',
    title: '把出发前的事情一件件准备好',
    module: '行前准备资料（生成后）',
    intro: '初步方案生成后，以任务卡方式逐步补齐，不把你重新拖回 9 步主问卷。',
  },
] as const satisfies readonly PlannerStepSpec[];

/**
 * 76 条字段元数据，按页面区块顺序排列。
 *
 * `as const satisfies` 而不是 `: readonly PlannerFieldSpec[]`：前者保留字面量
 * 类型，因此 `PlannerFieldId` 能派生成 76 个字面量的联合 —— 那是
 * `source_field_id` 拼错在编译期就报错的唯一途径。后者会把它退化成 `string`。
 */
export const PLANNER_FIELDS = [
  {
    field_id: 'PV2-01-001',
    step: '01',
    api_key: 'trip.origin',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '出发地/常住地',
    control: '地点选择器+搜索',
    trigger: '始终显示',
    validation: '必须可解析到城市+国家；允许补充具体机场/车站',
  },
  {
    field_id: 'PV2-01-002',
    step: '01',
    api_key: 'trip.destination_status',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '目的地是否已经确定？',
    control: '单选卡片',
    trigger: '始终显示',
    validation: '只能选择“已经确定”或“有几个备选”；不能跳过具体目的地',
  },
  {
    field_id: 'PV2-01-003',
    step: '01',
    api_key: 'trip.destinations',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'array<object>',
    question: '目的地/备选目的地',
    control: '可增删地点选择器',
    trigger: '始终显示',
    validation: '至少1个；每个地点需解析到国家/城市',
  },
  {
    field_id: 'PV2-01-004',
    step: '01',
    api_key: 'trip.dates',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'date_range',
    question: '出发日期与返回日期',
    control: '日期区间选择器',
    trigger: '始终显示',
    validation: '返回日期不得早于出发日期；跨时区按当地日历日展示',
  },
  {
    field_id: 'PV2-01-005',
    step: '01',
    api_key: 'trip.date_flexibility',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '日期弹性',
    control: '单选卡片',
    trigger: '始终显示',
    validation: '若“日期固定”则日期区间必填；其他模式允许系统给出建议窗口',
  },
  {
    field_id: 'PV2-01-006',
    step: '01',
    api_key: 'profile.trip_purposes',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '这次旅行主要为了什么？',
    control: '多选卡片+其他',
    trigger: '始终显示',
    validation: '至少选择1项，最多4项；“其他”需补充文字',
  },
  {
    field_id: 'PV2-01-007',
    step: '01',
    api_key: 'profile.top_goals',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'ranked_array',
    question: '本次旅行最重要的3件事',
    control: '可排序多选卡片',
    trigger: '始终显示',
    validation: '必须排序1~3项；第1项权重最高',
  },
  {
    field_id: 'PV2-01-008',
    step: '01',
    api_key: 'trip.locked_order_types',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '已经有哪些不可变的预订？',
    control: '多选卡片',
    trigger: '始终显示',
    validation: '“无”与其他选项互斥',
  },
  {
    field_id: 'PV2-01-009',
    step: '01',
    api_key: 'trip.locked_orders',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'array<object>',
    question: '填写已有订单详情',
    control: '动态Repeater/订单卡',
    trigger: '已选择任一已有订单',
    validation: '日期需落在或关联旅行窗口；至少填写名称+时间/日期+地点',
  },

  {
    field_id: 'PV2-02-001',
    step: '02',
    api_key: 'travelers.count',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'integer',
    question: '同行人数',
    control: '计数器',
    trigger: '始终显示',
    validation: '>=1；与Traveler Card数量一致',
  },
  {
    field_id: 'PV2-02-002',
    step: '02',
    api_key: 'travelers.profiles',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'MEDIUM',
    data_type: 'array<object>',
    question: '各年龄段有几位旅行人员？',
    control: 'Traveler Card Repeater',
    trigger: '同行人数>0',
    validation: '每位旅行者至少年龄段+关系；儿童建议填写具体年龄',
  },
  {
    field_id: 'PV2-02-003',
    step: '02',
    api_key: 'travelers.minor_guardianship',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'SENSITIVE',
    data_type: 'enum',
    question: '未成年人由谁陪同？',
    control: '单选+补充',
    trigger: '存在<18岁旅行者',
    validation: '存在未成年人必须回答；不要求上传法律文件到主问卷',
  },
  {
    field_id: 'PV2-02-004',
    step: '02',
    api_key: 'travelers.mobility_level',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'enum',
    question: '整体步行/站立能力',
    control: '单选卡片',
    trigger: '始终显示',
    validation: '不得仅根据年龄自动填写；用户可跳过',
  },
  {
    field_id: 'PV2-02-005',
    step: '02',
    api_key: 'travelers.child_needs',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'array<enum>',
    question: '儿童出行需要哪些安排？',
    control: '多选',
    trigger: '存在儿童/婴幼儿',
    validation: '若选“固定午睡”继续采集时间窗；若选安全座椅触发交通供应商核验',
  },
  {
    field_id: 'PV2-02-006',
    step: '02',
    api_key: 'travelers.grouping_needs',
    level: 'CONDITIONAL',
    runtime_type: 'FACT',
    priority: 'P1',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '同行人是否需要分房/分车/分开活动？',
    control: '多选+备注',
    trigger: '同行人数>=3',
    validation: '“全程一起”与其他可按产品策略互斥',
  },

  {
    field_id: 'PV2-03-001',
    step: '03',
    api_key: 'budget.mode',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '你更容易用哪种方式表达预算？',
    control: '单选卡片',
    trigger: '始终显示',
    validation: '根据选择动态显示金额或档次字段',
  },
  {
    field_id: 'PV2-03-002',
    step: '03',
    api_key: 'budget.currency',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'string',
    question: '预算币种',
    control: '下拉选择',
    trigger: '预算模式≠暂无明确预算',
    validation: 'ISO 4217币种代码',
  },
  {
    field_id: 'PV2-03-003',
    step: '03',
    api_key: 'budget.target_range',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'money_range',
    question: '目标预算范围',
    control: '金额区间输入',
    trigger: '预算模式=总预算/人均预算',
    validation: '最低<=最高；不得为负；明确预算主体（总额或人均）',
  },
  {
    field_id: 'PV2-03-004',
    step: '03',
    api_key: 'budget.travel_tier',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '希望整体是什么档次？',
    control: '单选卡片',
    trigger: '预算模式=旅行档次/暂无明确预算',
    validation: '档次不绑定固定人民币/天；金额由目的地动态估算',
  },
  {
    field_id: 'PV2-03-005',
    step: '03',
    api_key: 'budget.hard_cap',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'CONDITIONAL',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'money',
    question: '有没有绝对不能超过的金额？',
    control: '金额输入+开关',
    trigger: '预算模式≠暂无明确预算',
    validation: '若填写必须>=目标预算下限；硬上限优先级高于档次偏好',
  },
  {
    field_id: 'PV2-03-006',
    step: '03',
    api_key: 'budget.scope_and_priorities',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '预算包含哪些项目？哪些项目愿意多花？',
    control: '多选+三态标签',
    trigger: '始终显示',
    validation: '预算范围至少包含1项；消费重点最多建议3项',
  },

  {
    field_id: 'PV2-04-001',
    step: '04',
    api_key: 'pace.level',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'integer',
    question: '整体旅行节奏',
    control: '5级滑块',
    trigger: '始终显示',
    validation: '1~5；默认3',
  },
  {
    field_id: 'PV2-04-002',
    step: '04',
    api_key: 'pace.daily_window',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'time_range',
    question: '最早出门与最晚结束时间',
    control: '双时间选择器',
    trigger: '始终显示',
    validation: '开始<结束；跨午夜需明确夜间活动模式',
  },
  {
    field_id: 'PV2-04-003',
    step: '04',
    api_key: 'pace.walking_tolerance',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '每天可接受步行量',
    control: '分档选择器',
    trigger: '始终显示',
    validation: '不与行动能力冲突；若冲突取更保守值',
  },
  {
    field_id: 'PV2-04-004',
    step: '04',
    api_key: 'pace.core_activities_per_day',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '每天希望安排几个核心项目？',
    control: '单选',
    trigger: '始终显示',
    validation: '与节奏等级联动但不强制同步',
  },
  {
    field_id: 'PV2-04-005',
    step: '04',
    api_key: 'pace.free_time',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '每天希望留多少自由时间？',
    control: '单选',
    trigger: '始终显示',
    validation: '默认“1小时左右”或根据节奏推导',
  },
  {
    field_id: 'PV2-04-006',
    step: '04',
    api_key: 'pace.rest_window',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'time_range',
    question: '是否需要固定午休或午睡？',
    control: '开关+时间范围',
    trigger: '儿童需求含固定午睡/用户主动开启',
    validation: '开始<结束；仅在相关旅行者适用',
  },
  {
    field_id: 'PV2-04-007',
    step: '04',
    api_key: 'pace.hotel_change_tolerance',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'enum',
    question: '最多愿意换几次住宿？',
    control: '单选',
    trigger: '多城市时优先显示',
    validation: '不直接要求普通用户理解“中心辐射”等规划术语',
  },
  {
    field_id: 'PV2-04-008',
    step: '04',
    api_key: 'risk.exclusions',
    level: 'MAIN',
    runtime_type: 'EXCLUDE',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'EXCLUDE',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '哪些方式你不能接受？',
    control: '多选排除标签',
    trigger: '始终显示',
    validation: '排除项不得被模型主动违反；若无可行方案需回问',
  },

  {
    field_id: 'PV2-05-001',
    step: '05',
    api_key: 'transport.intercity_modes',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<stance>',
    question: '偏好的跨城交通方式',
    control: '三态标签',
    trigger: '存在跨城/多目的地',
    validation: '支持偏好/必须/不要；无选择表示系统决定',
  },
  {
    field_id: 'PV2-05-002',
    step: '05',
    api_key: 'transport.flight_constraints',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'CONDITIONAL',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '对直飞和转机有什么要求？',
    control: '单选+多选',
    trigger: '涉及航空交通',
    validation: '若选只直飞则不可推荐转机；转机需触发过境核验',
  },
  {
    field_id: 'PV2-05-003',
    step: '05',
    api_key: 'transport.flight_comfort',
    level: 'CONDITIONAL',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '偏好舱等与座位',
    control: '多选/单选',
    trigger: '涉及航空交通',
    validation: '多人时可支持“儿童需相邻”等硬约束',
  },
  {
    field_id: 'PV2-05-004',
    step: '05',
    api_key: 'transport.time_preferences',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '更喜欢什么时间出发/抵达？',
    control: '多选时间段',
    trigger: '涉及长途交通',
    validation: '若与已有订单冲突，以Locked Constraint为准',
  },
  {
    field_id: 'PV2-05-005',
    step: '05',
    api_key: 'transport.local_modes',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<stance>',
    question: '到当地后更偏好怎么移动？',
    control: '三态标签',
    trigger: '始终显示',
    validation: '支持偏好/必须/不要',
  },
  {
    field_id: 'PV2-05-006',
    step: '05',
    api_key: 'transport.self_drive',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'SENSITIVE',
    data_type: 'object',
    question: '自驾计划详情',
    control: '动态表单',
    trigger: '选择自驾=偏好或必须',
    validation: '不在主问卷采集驾照号码；只采集核验条件',
  },
  {
    field_id: 'PV2-05-007',
    step: '05',
    api_key: 'transport.luggage_profile',
    level: 'CONDITIONAL',
    runtime_type: 'FACT',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '长途交通时预计带多少行李？',
    control: '计数器+类型',
    trigger: '涉及航空/铁路/租车',
    validation: '件数>=0；特殊器材触发行李规则核验',
  },

  {
    field_id: 'PV2-06-001',
    step: '06',
    api_key: 'lodging.types',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<stance>',
    question: '偏好的住宿类型',
    control: '三态标签',
    trigger: '始终显示',
    validation: '支持偏好/必须/不要；无选择由系统推荐',
  },
  {
    field_id: 'PV2-06-002',
    step: '06',
    api_key: 'lodging.rooms_count',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'integer',
    question: '需要几间房？',
    control: '计数器',
    trigger: '始终显示',
    validation: '>=1；与同行人数/房型配置逻辑一致',
  },
  {
    field_id: 'PV2-06-003',
    step: '06',
    api_key: 'lodging.room_configuration',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'array<object>',
    question: '床型与房间关系要求',
    control: '多选+Repeater',
    trigger: '已设置房间数',
    validation: '房间配置必须能够容纳全部旅行者；连通房标记为需供应商确认',
  },
  {
    field_id: 'PV2-06-004',
    step: '06',
    api_key: 'lodging.nightly_budget',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'MEDIUM',
    data_type: 'money_range',
    question: '住宿每晚预算',
    control: '金额区间+币种继承',
    trigger: '预算模式允许细分时显示',
    validation: '若与总预算冲突，提示而非静默覆盖',
  },
  {
    field_id: 'PV2-06-005',
    step: '06',
    api_key: 'lodging.location_priorities',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'ranked_array',
    question: '住宿更看重什么？',
    control: '可排序多选',
    trigger: '始终显示',
    validation: '最多排序3项',
  },
  {
    field_id: 'PV2-06-006',
    step: '06',
    api_key: 'lodging.class_and_brand',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '对星级/品牌有要求吗？',
    control: '单选+搜索',
    trigger: '住宿类型含酒店/度假村',
    validation: '品牌为空不限制；星级仅作目的地可比参考',
  },
  {
    field_id: 'PV2-06-007',
    step: '06',
    api_key: 'lodging.amenities',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<stance>',
    question: '住宿必须/偏好的设施',
    control: '三态标签',
    trigger: '始终显示',
    validation: '轮椅、电梯等安全/无障碍项若为实际需求应自动升级HARD',
  },
  {
    field_id: 'PV2-06-008',
    step: '06',
    api_key: 'lodging.sleep_checkin_needs',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '睡眠和入住有什么硬要求？',
    control: '多选+时间',
    trigger: '有相关偏好或抵达时间特殊',
    validation: '晚到时间超过前台时间时必须进入VERIFY',
  },

  {
    field_id: 'PV2-07-001',
    step: '07',
    api_key: 'food.experience_tags',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '喜欢哪些餐饮体验？',
    control: '多选标签',
    trigger: '始终显示',
    validation: '最多建议6项，支持搜索扩展',
  },
  {
    field_id: 'PV2-07-002',
    step: '07',
    api_key: 'food.dietary_requirements',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'MUST',
    sensitivity: 'SENSITIVE',
    data_type: 'array<enum>',
    question: '是否有必须遵守的饮食方式？',
    control: '多选',
    trigger: '始终显示',
    validation: '“无”与其他互斥；宗教/饮食要求不使用三态循环',
  },
  {
    field_id: 'PV2-07-003',
    step: '07',
    api_key: 'food.has_allergies',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'HIGH',
    data_type: 'enum',
    question: '是否存在食物过敏？',
    control: '单选',
    trigger: '始终显示',
    validation: '不能用“偏好/必须/不要”表达过敏',
  },
  {
    field_id: 'PV2-07-004',
    step: '07',
    api_key: 'food.allergy_details',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'MUST',
    sensitivity: 'HIGH',
    data_type: 'object',
    question: '过敏原与严重程度',
    control: '动态表单',
    trigger: '食物过敏=有',
    validation: '仅采集服务必要信息；严重过敏进入人工/供应商确认',
  },
  {
    field_id: 'PV2-07-005',
    step: '07',
    api_key: 'food.dining_style',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '用餐预算、排队和预约偏好',
    control: '多选+档位',
    trigger: '始终显示',
    validation: '与总预算联动；“不排队”可升级为EXCLUDE',
  },
  {
    field_id: 'PV2-07-006',
    step: '07',
    api_key: 'interests.tags',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '你对哪些旅行主题感兴趣？',
    control: '可搜索多选标签',
    trigger: '始终显示',
    validation: '建议选择2~8项；支持搜索扩展',
  },
  {
    field_id: 'PV2-07-007',
    step: '07',
    api_key: 'interests.top3',
    level: 'MAIN',
    runtime_type: 'PREFER',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'ranked_array',
    question: '最重要的3个兴趣',
    control: '拖拽排序',
    trigger: '已选兴趣>=3',
    validation: '必须从已选兴趣中选择；最多3项',
  },
  {
    field_id: 'PV2-07-008',
    step: '07',
    api_key: 'interests.must_do',
    level: 'MAIN',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'OPTIONAL',
    blocking: 'CONDITIONAL',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'array<object>',
    question: '哪些地方/活动不去会遗憾？',
    control: '搜索+自由输入Repeater',
    trigger: '始终显示',
    validation: '每项可附日期限制；无法满足时必须提示冲突',
  },
  {
    field_id: 'PV2-07-009',
    step: '07',
    api_key: 'interests.wish_and_exclude',
    level: 'MAIN',
    runtime_type: 'PREFER_EXCLUDE',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'EXCLUDE',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '还有哪些想去或明确不想安排？',
    control: '双列表/三态搜索',
    trigger: '始终显示',
    validation: '明确不要不得被模型主动安排',
  },
  {
    field_id: 'PV2-07-010',
    step: '07',
    api_key: 'shopping.intent',
    level: 'CONDITIONAL',
    runtime_type: 'PREFER',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'PREFER',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '是否有明确购物/退税目标？',
    control: '开关+多选+预算',
    trigger: '兴趣含购物或主动开启',
    validation: '大额购物预算与总预算口径需明确是否包含',
  },

  {
    field_id: 'PV2-08-001',
    step: '08',
    api_key: 'special.has_health_or_accessibility_needs',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'CONDITIONAL',
    summary_group: 'VERIFY',
    sensitivity: 'HIGH',
    data_type: 'enum',
    question: '是否有会影响旅行安排的健康、行动或无障碍需求？',
    control: '单选',
    trigger: '始终显示',
    validation: '主流程只问“是否存在”，不要要求诊断信息',
  },
  {
    field_id: 'PV2-08-002',
    step: '08',
    api_key: 'special.health_accessibility_needs',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'MUST',
    sensitivity: 'HIGH',
    data_type: 'object',
    question: '需要我们在行程中照顾哪些实际需求？',
    control: '多选+备注',
    trigger: '健康/无障碍入口=有',
    validation: '只采功能性需求；必要医疗细节建议由专业人士评估',
  },
  {
    field_id: 'PV2-08-003',
    step: '08',
    api_key: 'special.high_risk_activities',
    level: 'MAIN',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'CONDITIONAL',
    summary_group: 'VERIFY',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '是否计划高原、潜水或其他高风险活动？',
    control: '多选',
    trigger: '始终显示',
    validation: '“无”与其他互斥；有相关活动则保险核验必做',
  },
  {
    field_id: 'PV2-08-004',
    step: '08',
    api_key: 'special.medication_status',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'CONDITIONAL',
    summary_group: 'VERIFY',
    sensitivity: 'HIGH',
    data_type: 'enum',
    question: '旅行期间是否需要携带处方药/受控药物？',
    control: '单选',
    trigger: '国际旅行或健康需求=有',
    validation: '不在此处要求药名；选择“需要”后进入必要信息流程',
  },
  {
    field_id: 'PV2-08-005',
    step: '08',
    api_key: 'documents.nationality_residency',
    level: 'CONDITIONAL',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'SENSITIVE',
    data_type: 'object',
    question: '国籍与长期居留地',
    control: '两个下拉/搜索',
    trigger: '系统判断为跨境国际旅行',
    validation: '仅收国家，不默认收身份证/居留证号码',
  },
  {
    field_id: 'PV2-08-006',
    step: '08',
    api_key: 'documents.passport_status',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'HIGH',
    data_type: 'object',
    question: '护照有效期/状态',
    control: '日期+单选',
    trigger: '跨境国际旅行',
    validation: '只需到期日与状态；不在主问卷采集护照号码',
  },
  {
    field_id: 'PV2-08-007',
    step: '08',
    api_key: 'documents.visa_status',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'SENSITIVE',
    data_type: 'object',
    question: '当前是否已有目的地签证/ETA？',
    control: '单选+有效期可选',
    trigger: '跨境国际旅行',
    validation: '用户自报不视为最终结论；必须后台核验',
  },
  {
    field_id: 'PV2-08-008',
    step: '08',
    api_key: 'insurance.status',
    level: 'MAIN',
    runtime_type: 'VERIFY_NONBLOCKING',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'VERIFY',
    sensitivity: 'MEDIUM',
    data_type: 'enum',
    question: '是否已有覆盖本次旅行的旅行保险？',
    control: '单选',
    trigger: '始终显示；高风险活动时提升为条件必填',
    validation: '若有高风险活动，必须确认是否承保',
  },
  {
    field_id: 'PV2-08-009',
    step: '08',
    api_key: 'safety.contexts',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '是否存在需要提高安全阈值的场景？',
    control: '多选',
    trigger: '独行、夜生活或特殊抵达条件',
    validation: '“无”与其他互斥；不询问不必要的身份细节',
  },
  {
    field_id: 'PV2-08-010',
    step: '08',
    api_key: 'special.work_constraints',
    level: 'CONDITIONAL',
    runtime_type: 'HARD',
    priority: 'P1',
    required: 'CONDITIONAL',
    blocking: 'NEVER',
    summary_group: 'MUST',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '旅行中是否有不能移动的工作安排？',
    control: '开关+时间Repeater',
    trigger: '旅行目的含商务+休闲或主动开启',
    validation: '时间使用目的地时区；必须与行程日期相交',
  },

  {
    field_id: 'PV2-09-001',
    step: '09',
    api_key: 'review.constraints_snapshot',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '确认旅行骨架、必须/偏好/排除项',
    control: '复核面板',
    trigger: '完成前8步后',
    validation: '必须逐组可编辑回跳；不得仅显示“完成度百分比”',
  },
  {
    field_id: 'PV2-09-002',
    step: '09',
    api_key: 'review.blocking_answers',
    level: 'CONDITIONAL',
    runtime_type: 'VERIFY_BLOCKING',
    priority: 'P0',
    required: 'CONDITIONAL',
    blocking: 'ALWAYS',
    summary_group: 'VERIFY',
    sensitivity: 'SENSITIVE',
    data_type: 'object',
    question: '补充会阻塞方案生成的问题',
    control: '动态问题列表',
    trigger: '存在blocker=是且状态未完成',
    validation: '只显示真正阻塞或高风险项目',
  },
  {
    field_id: 'PV2-09-003',
    step: '09',
    api_key: 'service.notification_preferences',
    level: 'MAIN',
    runtime_type: 'FACT',
    priority: 'P1',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'SKELETON',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '希望我们怎样提醒你？',
    control: '单选+渠道',
    trigger: '始终显示',
    validation: '渠道必须是产品实际支持范围，不展示未实现渠道',
  },
  {
    field_id: 'PV2-09-004',
    step: '09',
    api_key: 'profile.additional_notes',
    level: 'MAIN',
    runtime_type: 'INFO',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'MEDIUM',
    data_type: 'string',
    question: '还有什么没有覆盖但希望我们知道？',
    control: '自由文本',
    trigger: '始终显示',
    validation: '建议500字；若识别到已有结构化字段，应提示同步勾选',
  },
  {
    field_id: 'PV2-09-005',
    step: '09',
    api_key: 'privacy.trip_processing_consent',
    level: 'MAIN',
    runtime_type: 'CONSENT',
    priority: 'P0',
    required: 'ALWAYS',
    blocking: 'ALWAYS',
    summary_group: 'HIDDEN',
    sensitivity: 'HIGH',
    data_type: 'boolean',
    question: '同意本次服务使用所提供的信息',
    control: '勾选框+详情链接',
    trigger: '提交前',
    validation: '必须显式同意；不同意则不能处理需敏感数据的功能',
  },
  {
    field_id: 'PV2-09-006',
    step: '09',
    api_key: 'privacy.save_preferences',
    level: 'MAIN',
    runtime_type: 'CONSENT',
    priority: 'P1',
    required: 'ALWAYS',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'SENSITIVE',
    data_type: 'boolean',
    question: '是否保存非敏感旅行偏好用于未来服务？',
    control: '开关',
    trigger: '提交前',
    validation: '默认建议不预勾选；与本次服务授权分开',
  },

  {
    field_id: 'PV2-10-001',
    step: '10',
    api_key: 'pretrip.connectivity',
    level: 'POST_PLAN',
    runtime_type: 'INFO',
    priority: 'P2',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'NORMAL',
    data_type: 'object',
    question: '手机是否支持eSIM/希望怎样联网？',
    control: '单选+多选',
    trigger: '初步方案生成后',
    validation: '不阻塞初步行程生成',
  },
  {
    field_id: 'PV2-10-002',
    step: '10',
    api_key: 'pretrip.payment_methods',
    level: 'POST_PLAN',
    runtime_type: 'INFO',
    priority: 'P2',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'MEDIUM',
    data_type: 'object',
    question: '主要支付方式与备用方式',
    control: '多选',
    trigger: '初步方案生成后',
    validation: '不采集卡号/CVV/账户密码',
  },
  {
    field_id: 'PV2-10-003',
    step: '10',
    api_key: 'pretrip.loyalty_programs',
    level: 'POST_PLAN',
    runtime_type: 'INFO',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'MEDIUM',
    data_type: 'array<object>',
    question: '可用于本次旅行的会员权益',
    control: 'Repeater',
    trigger: '初步方案生成后或用户主动展开',
    validation: '不要求会员账号密码；编号原则上非必要不收',
  },
  {
    field_id: 'PV2-10-004',
    step: '10',
    api_key: 'pretrip.emergency_contact',
    level: 'POST_PLAN',
    runtime_type: 'CONSENT',
    priority: 'P1',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'HIGH',
    data_type: 'object',
    question: '紧急联系人和位置共享偏好',
    control: '联系人+授权开关',
    trigger: '深度服务或旅中管家开启时',
    validation: '必须明确用途与保存期限；位置共享独立授权',
  },
  {
    field_id: 'PV2-10-005',
    step: '10',
    api_key: 'pretrip.imported_documents',
    level: 'POST_PLAN',
    runtime_type: 'INFO',
    priority: 'P2',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'HIGH',
    data_type: 'array<file_ref>',
    question: '上传或导入已有订单与旅行文件',
    control: '文件上传/邮箱导入入口',
    trigger: '用户选择深度服务',
    validation: '文件类型/大小限制；敏感证件需最小权限与可删除机制',
  },
  {
    field_id: 'PV2-10-006',
    step: '10',
    api_key: 'service.monitoring_topics',
    level: 'POST_PLAN',
    runtime_type: 'INFO',
    priority: 'P2',
    required: 'OPTIONAL',
    blocking: 'NEVER',
    summary_group: 'HIDDEN',
    sensitivity: 'NORMAL',
    data_type: 'array<enum>',
    question: '希望旅中监控哪些变化？',
    control: '多选开关',
    trigger: '初步方案生成后',
    validation: '安全警报可按产品策略设为默认推荐，但需说明',
  },
] as const satisfies readonly PlannerFieldSpec[];

/**
 * 字段总数。写成常量供测试断言 —— 规范 21.1 与附录 C 都把它列为**阻塞发布**
 * 的硬门槛，而「视觉复合控件不改变这一数量」意味着重构 UI 时最容易破的正是它。
 */
export const PLANNER_FIELD_COUNT = 76;

/** 76 个字面量的联合。`source_field_id` 用它，拼错是编译错误 */
export type PlannerFieldId = (typeof PLANNER_FIELDS)[number]['field_id'];

/** 76 个 API Key 的联合。契约绑定用它 */
export type PlannerApiKey = (typeof PLANNER_FIELDS)[number]['api_key'];

/**
 * 首次攻略的用户回答要求。
 *
 * 这与字段表原始的 `required` / `blocking` 分开：那两列是 V2.1 的历史输入，
 * 本表是《旅行规划必填项与条件交互设计》评审后的可执行产品决策。
 */
export const PLANNER_REQUIREMENT_MODE_VALUES = [
  'BASE_REQUIRED',
  'CONDITIONAL_REQUIRED',
  'OPTIONAL',
  'POST_PLAN',
  'SYSTEM',
] as const;
export type PlannerRequirementMode = (typeof PLANNER_REQUIREMENT_MODE_VALUES)[number];

export const PLANNER_REQUIREMENT_TRIGGER_VALUES = [
  'LOCKED_ORDER_SELECTED',
  'MINOR_PRESENT',
  'CHILD_PRESENT',
  'BUDGET_MONEY_MODE',
  'BUDGET_TIER_MODE',
  'HARD_CAP_ENABLED',
  'FIXED_REST_ENABLED',
  'SELF_DRIVE_SELECTED',
  'ROOM_COUNT_SET',
  'ALLERGY_YES',
  'HEALTH_YES',
  'INTERNATIONAL_OR_HEALTH',
  'INTERNATIONAL',
  'HIGH_RISK_ACTIVITY',
  'WORK_CONSTRAINT_ENABLED',
] as const;
export type PlannerRequirementTrigger = (typeof PLANNER_REQUIREMENT_TRIGGER_VALUES)[number];

export const PLANNER_BLOCKING_SCOPE_VALUES = ['PLAN', 'BRANCH', 'NONE'] as const;
export type PlannerBlockingScope = (typeof PLANNER_BLOCKING_SCOPE_VALUES)[number];

export const PLANNER_REQUIREMENT_REASON_VALUES = [
  'ROUTE_SKELETON',
  'TRAVELER_SAFETY',
  'BUDGET_MEANING',
  'LOCKED_ORDER',
  'LEGAL_FEASIBILITY',
  'CUSTOM_CONFIGURATION',
  'HEALTH_SAFETY',
  'CONSENT',
] as const;
export type PlannerRequirementReason = (typeof PLANNER_REQUIREMENT_REASON_VALUES)[number];

export interface PlannerFieldRequirement {
  readonly field_id: PlannerFieldId;
  readonly requirement_mode: PlannerRequirementMode;
  readonly blocking_scope: PlannerBlockingScope;
  readonly reason_code?: PlannerRequirementReason;
  readonly trigger_code?: PlannerRequirementTrigger;
  readonly allow_clear: boolean;
  readonly allow_change_source: boolean;
}

const BASE_REQUIRED_FIELD_IDS = new Set<PlannerFieldId>([
  'PV2-01-001',
  'PV2-01-002',
  'PV2-01-003',
  'PV2-01-004',
  'PV2-01-008',
  'PV2-02-001',
  'PV2-02-002',
  'PV2-02-004',
  'PV2-03-001',
  'PV2-04-001',
  'PV2-07-002',
  'PV2-07-003',
  'PV2-08-001',
  'PV2-08-003',
  'PV2-09-001',
  'PV2-09-005',
]);

const CONDITIONAL_REQUIREMENTS = new Map<
  PlannerFieldId,
  {
    readonly trigger_code: PlannerRequirementTrigger;
    readonly blocking_scope: Exclude<PlannerBlockingScope, 'NONE'>;
    readonly reason_code: PlannerRequirementReason;
  }
>([
  [
    'PV2-01-009',
    { trigger_code: 'LOCKED_ORDER_SELECTED', blocking_scope: 'BRANCH', reason_code: 'LOCKED_ORDER' },
  ],
  [
    'PV2-02-003',
    { trigger_code: 'MINOR_PRESENT', blocking_scope: 'PLAN', reason_code: 'LEGAL_FEASIBILITY' },
  ],
  [
    'PV2-02-005',
    { trigger_code: 'CHILD_PRESENT', blocking_scope: 'PLAN', reason_code: 'TRAVELER_SAFETY' },
  ],
  [
    'PV2-03-002',
    { trigger_code: 'BUDGET_MONEY_MODE', blocking_scope: 'BRANCH', reason_code: 'BUDGET_MEANING' },
  ],
  [
    'PV2-03-003',
    { trigger_code: 'BUDGET_MONEY_MODE', blocking_scope: 'BRANCH', reason_code: 'BUDGET_MEANING' },
  ],
  [
    'PV2-03-004',
    { trigger_code: 'BUDGET_TIER_MODE', blocking_scope: 'BRANCH', reason_code: 'BUDGET_MEANING' },
  ],
  [
    'PV2-03-005',
    { trigger_code: 'HARD_CAP_ENABLED', blocking_scope: 'BRANCH', reason_code: 'BUDGET_MEANING' },
  ],
  [
    'PV2-03-006',
    { trigger_code: 'BUDGET_MONEY_MODE', blocking_scope: 'BRANCH', reason_code: 'BUDGET_MEANING' },
  ],
  [
    'PV2-04-006',
    { trigger_code: 'FIXED_REST_ENABLED', blocking_scope: 'BRANCH', reason_code: 'TRAVELER_SAFETY' },
  ],
  [
    'PV2-05-006',
    { trigger_code: 'SELF_DRIVE_SELECTED', blocking_scope: 'BRANCH', reason_code: 'LEGAL_FEASIBILITY' },
  ],
  [
    'PV2-06-003',
    { trigger_code: 'ROOM_COUNT_SET', blocking_scope: 'BRANCH', reason_code: 'CUSTOM_CONFIGURATION' },
  ],
  [
    'PV2-07-004',
    { trigger_code: 'ALLERGY_YES', blocking_scope: 'PLAN', reason_code: 'HEALTH_SAFETY' },
  ],
  [
    'PV2-08-002',
    { trigger_code: 'HEALTH_YES', blocking_scope: 'PLAN', reason_code: 'HEALTH_SAFETY' },
  ],
  [
    'PV2-08-004',
    {
      trigger_code: 'INTERNATIONAL_OR_HEALTH',
      blocking_scope: 'PLAN',
      reason_code: 'LEGAL_FEASIBILITY',
    },
  ],
  [
    'PV2-08-005',
    { trigger_code: 'INTERNATIONAL', blocking_scope: 'PLAN', reason_code: 'LEGAL_FEASIBILITY' },
  ],
  [
    'PV2-08-006',
    { trigger_code: 'INTERNATIONAL', blocking_scope: 'PLAN', reason_code: 'LEGAL_FEASIBILITY' },
  ],
  [
    'PV2-08-007',
    { trigger_code: 'INTERNATIONAL', blocking_scope: 'PLAN', reason_code: 'LEGAL_FEASIBILITY' },
  ],
  [
    'PV2-08-008',
    { trigger_code: 'HIGH_RISK_ACTIVITY', blocking_scope: 'PLAN', reason_code: 'HEALTH_SAFETY' },
  ],
  [
    'PV2-08-010',
    { trigger_code: 'WORK_CONSTRAINT_ENABLED', blocking_scope: 'BRANCH', reason_code: 'CUSTOM_CONFIGURATION' },
  ],
]);

function baseReason(fieldId: PlannerFieldId): PlannerRequirementReason {
  if (fieldId === 'PV2-09-005') return 'CONSENT';
  if (fieldId === 'PV2-01-008') return 'LOCKED_ORDER';
  if (fieldId.startsWith('PV2-02') || fieldId.startsWith('PV2-07') || fieldId.startsWith('PV2-08')) {
    return 'TRAVELER_SAFETY';
  }
  if (fieldId === 'PV2-03-001') return 'BUDGET_MEANING';
  return 'ROUTE_SKELETON';
}

/**
 * 76个字段的完整目标分类。数组顺序与 `PLANNER_FIELDS` 一致，因此配置响应、
 * 页面与评审文档都能按同一顺序展示。
 */
export const PLANNER_FIELD_REQUIREMENTS: readonly PlannerFieldRequirement[] = PLANNER_FIELDS.map(
  (field): PlannerFieldRequirement => {
    if (field.field_id === 'PV2-09-002') {
      return {
        field_id: field.field_id,
        requirement_mode: 'SYSTEM',
        blocking_scope: 'NONE',
        allow_clear: false,
        allow_change_source: false,
      };
    }
    if (field.level === 'POST_PLAN') {
      return {
        field_id: field.field_id,
        requirement_mode: 'POST_PLAN',
        blocking_scope: 'NONE',
        allow_clear: true,
        allow_change_source: false,
      };
    }
    if (BASE_REQUIRED_FIELD_IDS.has(field.field_id)) {
      return {
        field_id: field.field_id,
        requirement_mode: 'BASE_REQUIRED',
        blocking_scope: 'PLAN',
        reason_code: baseReason(field.field_id),
        allow_clear: false,
        allow_change_source: false,
      };
    }
    const conditional = CONDITIONAL_REQUIREMENTS.get(field.field_id);
    if (conditional !== undefined) {
      return {
        field_id: field.field_id,
        requirement_mode: 'CONDITIONAL_REQUIRED',
        blocking_scope: conditional.blocking_scope,
        reason_code: conditional.reason_code,
        trigger_code: conditional.trigger_code,
        allow_clear: true,
        allow_change_source: true,
      };
    }
    return {
      field_id: field.field_id,
      requirement_mode: 'OPTIONAL',
      blocking_scope: 'NONE',
      allow_clear: true,
      allow_change_source: false,
    };
  },
);

/** Runtime boundary for the published planner configuration. */
export const PlannerFieldRequirementSchema = z.object({
  field_id: z.custom<PlannerFieldId>(
    (value) =>
      typeof value === 'string' && PLANNER_FIELDS.some((field) => field.field_id === value),
    '未知的 Planner 字段 ID',
  ),
  requirement_mode: z.enum(PLANNER_REQUIREMENT_MODE_VALUES),
  blocking_scope: z.enum(PLANNER_BLOCKING_SCOPE_VALUES),
  reason_code: z.enum(PLANNER_REQUIREMENT_REASON_VALUES).optional(),
  trigger_code: z.enum(PLANNER_REQUIREMENT_TRIGGER_VALUES).optional(),
  allow_clear: z.boolean(),
  allow_change_source: z.boolean(),
});

export const PlannerFieldRequirementsSchema = z
  .array(PlannerFieldRequirementSchema)
  .length(PLANNER_FIELDS.length)
  .superRefine((requirements, context) => {
    const ids = new Set(requirements.map((requirement) => requirement.field_id));
    if (ids.size !== PLANNER_FIELDS.length) {
      context.addIssue({
        code: 'custom',
        message: '字段分类必须完整覆盖 76 个唯一 Field ID',
      });
    }
  });

const REQUIREMENT_BY_FIELD_ID: ReadonlyMap<PlannerFieldId, PlannerFieldRequirement> = new Map(
  PLANNER_FIELD_REQUIREMENTS.map((requirement) => [requirement.field_id, requirement]),
);

export function plannerFieldRequirement(fieldId: PlannerFieldId): PlannerFieldRequirement {
  const requirement = REQUIREMENT_BY_FIELD_ID.get(fieldId);
  if (requirement === undefined) throw new Error(`未知的 Planner 必填配置：${fieldId}`);
  return requirement;
}

/**
 * 字段在触发后是否属于生成前必填。
 *
 * `runtime_type: HARD` 只表示答案进入方案后的约束强度，不代表问题本身必填；
 * 真正的生成必填由评审后的 `PLANNER_FIELD_REQUIREMENTS` 决定。
 * 条件必填这里只进入候选清单，是否已触发由前端/后端按 `trigger_code` 判定。
 */
export function isPlannerFieldGenerationRequired(field: PlannerFieldSpec): boolean {
  const mode = plannerFieldRequirement(field.field_id as PlannerFieldId).requirement_mode;
  return mode === 'BASE_REQUIRED' || mode === 'CONDITIONAL_REQUIRED';
}

/** 后台配置接口下发给前端的默认生成必填字段清单。 */
export const PLANNER_GENERATION_REQUIRED_FIELD_IDS: readonly PlannerFieldId[] =
  PLANNER_FIELDS.filter(isPlannerFieldGenerationRequired).map((field) => field.field_id);

/**
 * field_id → 元数据。
 *
 * 用 `Map` 而不是对象字面量：键是 76 个运行期字符串，`Object.fromEntries` 的
 * 返回类型是 `{ [k: string]: … }`，要拿到 `Record<PlannerFieldId, …>` 必须
 * 断言一次；而 `Map` 的 `get` 本来就返回 `T | undefined`，在
 * `noUncheckedIndexedAccess` 之下与索引访问的行为一致，却不需要断言。
 */
const FIELD_BY_ID: ReadonlyMap<string, PlannerFieldSpec> = new Map(
  PLANNER_FIELDS.map((field) => [field.field_id, field]),
);

/**
 * 按 field_id 取元数据。
 *
 * 取不到就抛，不返回 undefined：调用方传的是 `PlannerFieldId`（字面量联合），
 * 因此取不到只可能是这张表和类型不同步 —— 那时静默返回 undefined 会让
 * 「摘要 chip 点了不跳转」这类症状离根因很远。
 */
export function plannerField(fieldId: PlannerFieldId): PlannerFieldSpec {
  const field = FIELD_BY_ID.get(fieldId);
  if (field === undefined) {
    throw new Error(`未知的 Planner 字段 ID：${fieldId}`);
  }
  return field;
}

/** 该步骤的字段，按页面区块顺序 */
export function plannerFieldsOfStep(step: PlannerStepId): readonly PlannerFieldSpec[] {
  return PLANNER_FIELDS.filter((field) => field.step === step);
}

/**
 * 规范 4 章的类型语义表：视觉、生成器行为与右侧位置。
 *
 * 与 `PLANNER_FIELDS` 分开是因为它按**类型**而不是按字段索引 —— 前端渲染
 * chip 与徽标时查的是类型，把这几句话抄进 76 行里会重复 76 次。
 *
 * `semantic` 是给生成器的一句话，会进 Prompt 的分段标题（见 @tps/llm 的
 * `describeConstraints`）；`aria` 是屏读文案 —— 规范 20 要求「任何状态不能
 * 只依赖颜色，必须同时使用文字、图标和 aria-label」。
 */
export interface PlannerRuntimeTypeMeta {
  readonly label: string;
  readonly semantic: string;
  readonly aria: string;
  readonly summary_group: PlannerSummaryGroup;
}

export const PLANNER_RUNTIME_TYPE_META: Record<PlannerRuntimeType, PlannerRuntimeTypeMeta> = {
  FACT: {
    label: '事实',
    semantic: '用户或系统事实，不可为了方案好看而改写',
    aria: '事实信息',
    summary_group: 'SKELETON',
  },
  HARD: {
    label: '必须满足',
    semantic: '方案必须满足，不能满足时进入显式冲突解决',
    aria: '必须满足的条件',
    summary_group: 'MUST',
  },
  PREFER: {
    label: '优先满足',
    semantic: '推荐评分权重，冲突时可权衡但理由须可解释',
    aria: '优先满足的偏好',
    summary_group: 'PREFER',
  },
  EXCLUDE: {
    label: '明确不要',
    semantic: '不得主动安排，只有用户明确放宽后才可改变',
    aria: '明确排除的项',
    summary_group: 'EXCLUDE',
  },
  PREFER_EXCLUDE: {
    label: '想去 / 不要',
    semantic: '左列进优先满足，右列进明确不要',
    aria: '想去或明确不要的项',
    summary_group: 'PREFER',
  },
  VERIFY_BLOCKING: {
    label: '待系统核验',
    semantic: '用户完成必要回答后由系统继续核验，不阻止初步方案生成',
    aria: '待系统核验，不影响生成',
    summary_group: 'VERIFY',
  },
  VERIFY_NONBLOCKING: {
    label: '待系统核验',
    semantic: '可先生成初步方案，但结果中必须标明尚未核验',
    aria: '待系统核验，不影响生成',
    summary_group: 'VERIFY',
  },
  CONSENT: {
    label: '授权',
    semantic: '独立授权，不预勾选，不与营销或长期偏好绑定',
    aria: '信息使用授权',
    summary_group: 'HIDDEN',
  },
  INFO: {
    label: '补充信息',
    semantic: '无法结构化的长尾需求，不得据此静默改写硬约束',
    aria: '补充说明',
    summary_group: 'HIDDEN',
  },
};

/**
 * 字段的运行时类型 → 运行时约束类型。
 *
 * 只有 `PREFER_EXCLUDE` 不是一对一：它在派生时按左右列拆成两条约束，
 * 因此这张表给不出单一答案。返回 `null` 让调用方显式处理这一种，
 * 而不是默默按 PREFER 算掉右列的排除项 —— 后者会让「明确不要」凭空消失。
 */
export function constraintTypeOf(runtime: PlannerRuntimeType): PlannerConstraintType | null {
  return runtime === 'PREFER_EXCLUDE' ? null : runtime;
}
