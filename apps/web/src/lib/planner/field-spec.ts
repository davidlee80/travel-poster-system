import { CONDITION_LABEL } from '@tps/presentation';
import { plannerField, type PlannerFieldId } from '@tps/schemas';

/**
 * 选项值 → 展示文案。
 *
 * ## 为什么条件码的文案不在这里
 *
 * 61 个条件码的中文标签已经在 `@tps/presentation` 的 `CONDITION_LABEL` 里，
 * 而那份表是 `Record<ConditionCode, string>` —— 新增码漏配标签是**编译错误**。
 * 在这里再抄一份会失去那个保护，且两份必然漂移（漂移的表现是同一个标签
 * 在表单里叫「打车或网约车」、在右栏 chip 里叫 `transport.ride_hailing`）。
 *
 * 因此这里只放**问卷枚举**的文案（P9-4 补全），条件码一律转发过去。
 */

/** 问卷枚举值 → 中文。P9-4 随控件一起补全 */
export const OPTION_LABEL: Record<string, string> = {};

/**
 * 取一个选项值的展示文案。
 *
 * 顺序：条件码表 → 问卷枚举表 → 原值。回退到原值而不是空串：
 * 一个显示 `LEISURE` 的 chip 至少让人看出漏配了文案，
 * 而一个空 chip 看起来像渲染错误。
 */
export function optionLabel(value: string): string {
  const condition = (CONDITION_LABEL as Record<string, string | undefined>)[value];
  if (condition !== undefined) return condition;
  return OPTION_LABEL[value] ?? value;
}

/**
 * 高度敏感字段在右栏只显示抽象状态（规范 17.2 与 20）。
 *
 * 规范给的例子是「存在严重食物过敏需求」而不是具体过敏原。这张表的每一条都是
 * 「有这件事」而不是「这件事的内容」—— 右栏是一个常驻可见的面板，
 * 在咖啡馆里被旁人看到具体病史或证件状态与被看到「存在健康需求」性质不同。
 */
export const ABSTRACT_SUMMARY: Partial<Record<PlannerFieldId, string>> = {
  'PV2-02-002': '已登记同行旅行者档案',
  'PV2-02-003': '存在未成年人监护事项待确认',
  'PV2-05-006': '自驾资格待核验',
  'PV2-07-003': '存在食物过敏需求',
  'PV2-07-004': '存在需逐家核实的过敏安全约束',
  'PV2-08-001': '存在需要照顾的健康或无障碍需求',
  'PV2-08-002': '已登记无障碍与照护需求',
  'PV2-08-004': '存在随行药品合规事项待确认',
  'PV2-08-005': '已登记国籍与居留地',
  'PV2-08-006': '护照状态待核验',
  'PV2-10-004': '已登记紧急联系人',
  'PV2-10-005': '已导入旅行文件',
};

/** 这个字段在右栏是否只显示抽象状态 */
export function isMasked(fieldId: PlannerFieldId): boolean {
  return plannerField(fieldId).sensitivity === 'HIGH';
}
