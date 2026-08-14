/**
 * 五大数据契约的单一真相源（设计稿四章、22.1）。
 *
 * 这个包是整个系统最重要的一致性机制：API、Worker、React 模板全部从这里
 * 导入类型，因此 `TravelPosterViewModel` 与模板之间的字段不一致会变成
 * **编译错误**而不是运行期空白。设计稿 V1.0 在这一处出现过三个字段级
 * 不一致（见 6.2、12.2），单一真相源就是为了让同类问题不再复发。
 *
 * 交付节奏（见实施计划）：
 *   P1  TravelPosterViewModel（TP-1-01）、TravelPlan 与全部枚举（TP-1-02）
 *   P2  TravelRequestUI、NormalizedTravelRequest、条件字典（TP-2-03）
 *   P3  AssetRequirement、ResolvedAsset（TP-3-02）
 *
 * 约束：本包**不得引入除 zod 以外的运行时依赖** —— 它被所有应用引用，
 * 任何额外依赖都会成为全仓库的版本冲突面。
 */

export const SCHEMA_PACKAGE_VERSION = '0.0.0' as const;

/** 各契约的 schema_version 字面量，与设计稿一致 */
export const SCHEMA_VERSIONS = {
  travelRequestUi: 'travel_request_ui_v1',
  travelPlan: 'travel_plan_v1',
  assetRequirement: 'asset_requirement_v1',
  resolvedAsset: 'resolved_asset_v1',
  travelPosterViewModel: 'travel_poster_view_model_v1',
} as const;

export type SchemaVersionKey = keyof typeof SCHEMA_VERSIONS;
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[SchemaVersionKey];
