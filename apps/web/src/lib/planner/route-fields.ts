import type { FieldDescriptor, FieldPart } from './descriptors';
import type { EntryRoute } from './state';

/**
 * 路线专属的本地占位字段（第 1 步按路线定制的问卷内容）。
 *
 * ## 为什么不用契约字段
 *
 * 第 0 步四条路线（explore/destination/time/plan）各自对应一份设计稿
 * （design/new/01.html、02.html、03.html），其中的问题集与契约的 76 字段
 * 是**两套粒度**：设计稿的「大概能玩多久」是一个粗档位，契约里对应的
 * 是日期区间 + 天数推导；设计稿的「时间没定在等什么」契约里根本没有。
 * 在设计稿问题稳定下来之前，它们以 `RT-*` 占位字段存在 ——
 * 稳定且被需求确认后，好的问题会「转正」为契约字段（进 schemas 包评审）。
 *
 * ## 值存在哪里
 *
 * 全部写进 `answers.route_<route>` 这一个隔离块：
 *
 *   - 它**不是**契约 `planner_profile` 的 19 个块之一，因此提交前由
 *     `prepareProfile` 剔除（request.ts），后端永远不会看到它；
 *   - 它在 `answers` 里，所以草稿持久化（防抖 600ms）自动生效，
 *     不需要任何新机制；
 *   - 每条路线一个块：用户回第 0 步改选路线时，旧路线的值**留着**
 *     （与 optIns「收起不清值」同一哲学），切回来还在。
 *
 * ## 为什么不进 FIELD_DESCRIPTORS
 *
 * `FIELD_DESCRIPTORS` 的类型是 `Record<PlannerFieldId, …>`，少一个键是
 * 编译错误 —— 那是守护 76 字段契约完整性的。`RT-*` 不是契约字段，
 * 进那张表等于宣布它们是第 77 个字段。
 *
 * ## 触发 / 必填 / 完成度
 *
 * `RT-*` 字段恒显示（它们所在的第 1 步区块表本身就是路线过滤的结果），
 * 不参与 `TRIGGERS`、不参与必填徽标、不参与完成度 —— 三者的输入都是
 * 契约元数据表（`PLANNER_FIELDS`），`RT-*` 不在其中，天然被排除。
 * 第 1 步契约字段的必填/阻塞规则**不放松**（entry-routes.ts 的 TODO），
 * 路线内容表只做「显示什么」。
 */

/** 路线占位字段 ID（`RT-<路线>-<序号>`），刻意不属于 `PlannerFieldId` */
export type RouteFieldId =
  | 'RT-EXP-01'
  | 'RT-EXP-02'
  | 'RT-DST-01'
  | 'RT-DST-02'
  | 'RT-TIM-01'
  | 'RT-TIM-02'
  | 'RT-TIM-03'
  | 'RT-TIM-04';

export interface RouteFieldSpec {
  readonly fieldId: RouteFieldId;
  /**
   * 该字段在 answers 树里的读写路径（`route_<route>.<key>`）。
   *
   * `readAnswer` / `patchOf` 都是纯路径函数，因此占位字段复用整条
   * 读写管线（读值、写值、草稿持久化），只有「提交」这一个出口剔除它。
   */
  readonly apiKey: `route_${EntryRoute}.${string}`;
  /** 容器标题（FieldControl 的 question 位） */
  readonly question: string;
  readonly descriptor: Extract<FieldDescriptor, { kind: 'parts' }>;
  /**
   * 选项文案。契约字段的选项文案走 `OPTION_LABEL`（按 api_key 分层），
   * 占位字段的 apiKey 不在那张表里，文案由这里自带。
   */
  readonly labels: Readonly<Record<string, string>>;
}

/** 快捷构造：单部件字段（`key: null`，值即字段本身） */
function one(
  fieldId: RouteFieldId,
  apiKey: RouteFieldSpec['apiKey'],
  question: string,
  primitive: FieldPart['primitive'],
  part?: Partial<FieldPart>,
  labels: Readonly<Record<string, string>> = {},
): RouteFieldSpec {
  return {
    fieldId,
    apiKey,
    question,
    descriptor: { kind: 'parts', parts: [{ key: null, primitive, ...part }] },
    labels,
  };
}

/** 快捷构造：多部件字段（一个字段一张卡，每个部件一个键） */
function multi(
  fieldId: RouteFieldId,
  apiKey: RouteFieldSpec['apiKey'],
  question: string,
  parts: readonly FieldPart[],
  labels: Readonly<Record<string, string>> = {},
): RouteFieldSpec {
  return { fieldId, apiKey, question, descriptor: { kind: 'parts', parts }, labels };
}

// ── explore · 还没想好去哪（design/new/01.html）─────────────

/** 兴趣六宫格的值与文案（设计稿的 data-interest 六项） */
const EXP_INTEREST_OPTIONS = ['relax', 'food', 'nature', 'culture', 'family', 'quiet'] as const;
const EXP_INTEREST_LABELS: Readonly<Record<string, string>> = {
  relax: '休息放松',
  food: '吃点好的',
  nature: '亲近自然',
  culture: '人文漫游',
  family: '陪伴家人',
  quiet: '安静待着',
};

// ── destination · 假期有了（design/new/02.html）─────────────

const DST_TRANSPORT_OPTIONS = ['any', 'h3', 'h5', 'h8'] as const;
const DST_TRANSPORT_LABELS: Readonly<Record<string, string>> = {
  any: '暂无限制',
  h3: '3 小时以内',
  h5: '5 小时以内',
  h8: '8 小时以内',
};

// ── time · 有想去的地方（design/new/03.html）─────────────────

const TIM_REASON_OPTIONS = ['leave', 'friends', 'crowd', 'price', 'season'] as const;
const TIM_REASON_LABELS: Readonly<Record<string, string>> = {
  leave: '等假期',
  friends: '等同伴',
  crowd: '想避开旺季',
  price: '等合适价格',
  season: '不知道何时最好',
};

/**
 * 全部占位字段注册表。键即 `fieldId`，查不到就是拼错了 ——
 * 调用方（FieldControl）用 `isRouteFieldId` 守卫，不 throw。
 */
export const ROUTE_FIELDS: Readonly<Record<RouteFieldId, RouteFieldSpec>> = {
  /*
   * explore：设计稿问「出发地 / 期待 / 天数 / 预算 / 同伴」，后两者与
   * 第 3 步（预算）、第 2 步（人员）重复，按去重原则舍弃。
   */
  'RT-EXP-01': one(
    'RT-EXP-01',
    'route_explore.interests',
    '这次最想获得什么？',
    'check',
    { options: EXP_INTEREST_OPTIONS, hint: '不选也可以，后面我们会先给你几个不同方向。' },
    EXP_INTEREST_LABELS,
  ),
  /*
   * 天数是 choice 而不是 number：设计稿是四档下拉（不确定/2/4/7 天），
   * 值是字符串档位。契约要「具体几天」时有第 1 步日期区间推导，这里只要量级。
   */
  'RT-EXP-02': one(
    'RT-EXP-02',
    'route_explore.duration',
    '大概能玩多久？',
    'choice',
    { options: ['unknown', 'd2', 'd4', 'd7'] },
    { unknown: '不确定', d2: '2 天左右', d4: '4 天左右', d7: '7 天左右' },
  ),

  /*
   * destination：设计稿的「预算 / 预算口径 / 同行 / 总人数」与第 2、3 步
   * 重复，舍弃。日期模式用契约已有的 `trip.date_flexibility`
   * （PV2-01-005，choice）承载 —— 它本来就是「日期确定程度」的语义；
   * 日期区间本身仍写 `trip.dates`（PV2-01-004），与 plan 路线同一个键，
   * 摘要、投影、浏览器草稿全部不需要新逻辑。
   */
  'RT-DST-01': multi(
    'RT-DST-01',
    'route_destination.window',
    '最多可以玩几天？',
    [
      {
        key: 'max_days',
        primitive: 'number',
        min: 1,
        max: 30,
        placeholder: '例如：4',
        hint: '选了具体日期时留空即可，我们会按日期自动计算。',
      },
    ],
  ),
  'RT-DST-02': one(
    'RT-DST-02',
    'route_destination.transport_limit',
    '单程交通最多愿意花多久？',
    'choice',
    {
      options: DST_TRANSPORT_OPTIONS,
      hint: '含接驳、候车与换乘的门到门时间。',
    },
    DST_TRANSPORT_LABELS,
  ),

  /*
   * time：设计稿的「体验内容」与第 7 步兴趣标签有重叠，用户确认保留
   * （它带「需要核实的季节信息」语义，是自由文本而不是标签）。
   */
  'RT-TIM-01': multi(
    'RT-TIM-01',
    'route_time.window',
    '可以考虑哪些时间？',
    [
      {
        key: 'mode',
        primitive: 'choice',
        options: ['months', 'range', 'unknown'],
      },
      {
        key: 'months',
        primitive: 'text-list',
        label: '候选月份（含年份，最多 6 个）',
        placeholder: '例如：2026-10',
        requires: { key: 'mode', value: 'months' },
        hint: '只在你列出的月份内考虑日期，不会自动扩展到其他月份。',
      },
      {
        key: 'range',
        primitive: 'date-range',
        label: '可出行区间',
        requires: { key: 'mode', value: 'range' },
        hint: '整个旅程必须落在这个区间内。',
      },
    ],
    { months: '几个候选月', range: '一个日期区间', unknown: '还没有范围' },
  ),
  'RT-TIM-02': one(
    'RT-TIM-02',
    'route_time.duration',
    '大概玩几天？',
    'choice',
    {
      options: ['unknown', 'd2', 'd4', 'd7'],
      hint: '不确定也可以，日期示例会暂按 4 天估算，不代表替你确定时长。',
    },
    { unknown: '不确定', d2: '2 天左右', d4: '4 天左右', d7: '7 天左右' },
  ),
  'RT-TIM-03': one(
    'RT-TIM-03',
    'route_time.experience',
    '有没有特别想体验的内容？',
    'text',
    {
      placeholder: '例如：赏花、看雪、海边放松',
      hint: '用于明确需要核实的季节与活动信息。可留空。',
    },
  ),
  'RT-TIM-04': one(
    'RT-TIM-04',
    'route_time.reason',
    '时间没定，最主要在等什么？',
    'choice',
    { options: TIM_REASON_OPTIONS },
    TIM_REASON_LABELS,
  ),
};

/** 全部占位字段 ID（注册表键的镜像，供内容表引用时获得类型检查） */
export const ROUTE_FIELD_IDS = Object.keys(ROUTE_FIELDS) as readonly RouteFieldId[];

/** `fieldId` 是不是路线占位字段。FieldControl 的分岔守卫 */
export function isRouteFieldId(fieldId: string): fieldId is RouteFieldId {
  return Object.hasOwn(ROUTE_FIELDS, fieldId);
}
