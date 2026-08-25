import type { FieldPart } from '@/lib/planner/descriptors';

/**
 * 每个原语控件收到的东西。
 *
 * ## 为什么控件拿不到 `PlannerState`
 *
 * 控件只该知道「我的值」与「怎么改」。给它整个 state 之后，「顺手读一下
 * 另一个字段」就变得非常容易 —— 而那些跨字段读取会散落在 22 个控件里，
 * 让触发引擎与冲突检测不再是跨字段逻辑的唯一入口。
 *
 * 唯一的例外是 `options`：`interests.top3` 的选项取自 `interests.tags` 的
 * 当前答案。那次读取发生在 `PartControl` 里（描述符的 `options_from`），
 * 控件收到的仍然只是一个字符串数组。
 */
export interface ControlProps {
  readonly part: FieldPart;
  /** 字段的 api_key。选项文案按它分层查表（同名枚举值跨字段文案不同）*/
  readonly apiKey: string;
  readonly value: unknown;
  /** `undefined` = 清空。控件不自己决定「空」长什么样，由读写层删键 */
  readonly onChange: (next: unknown) => void;
  /** 控件的 DOM id。外层 label 的 `htmlFor` 指向它 */
  readonly id: string;
  /** 说明与错误文案的 id，进 `aria-describedby`（规范 20）*/
  readonly describedBy?: string;
  /** 已解析的选项值列表（配置中心的发布版本、静态选项或 `options_from` 的动态结果）*/
  readonly options: readonly string[];
  /**
   * 选项文案。
   *
   * 由父层从配置中心解析（`usePlannerOptionResolver`），配置缺失时回退到
   * 内置的 `optionLabel`。控件里**不再**直接调 `optionLabel` ——
   * 那会让运营改过的文案只在一部分控件里生效，而症状是
   * 「同一个标签在第 5 步显示新文案、在右栏摘要显示旧文案」。
   */
  readonly labelOf: (value: string) => string;
  /**
   * `object-list` 的固定行数，由描述符的 `follow_count` 解析而来。
   *
   * 与 `options` 同性质：都是「要读另一个字段才能得到的东西」，
   * 因此都在 `PartControl` 里解析完再传进来，控件本身仍然只看见值。
   */
  readonly rows?: number;
}
