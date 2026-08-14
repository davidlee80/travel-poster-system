/**
 * 各契约的 `schema_version` 字面量（设计稿四章）。
 *
 * 单独成文件是为了打断循环依赖：`travel-plan.ts` 与 `view-model.ts` 都需要
 * 它，而 `index.ts` 又需要它们。
 *
 * 版本号变更规则：字段的**新增**（可选）不递增版本；字段的删除、重命名、
 * 类型变更、枚举值移除都是破坏性变更，必须递增到 `_v2` 并保留 v1 的读取路径
 * —— `plan_presentations.view_model` 里存着历史版本的数据，旧版 ViewModel
 * 必须仍能渲染（设计稿「回滚策略」）。
 */
export const SCHEMA_VERSIONS = {
  travelRequestUi: 'travel_request_ui_v1',
  travelPlan: 'travel_plan_v1',
  assetRequirement: 'asset_requirement_v1',
  resolvedAsset: 'resolved_asset_v1',
  travelPosterViewModel: 'travel_poster_view_model_v1',
} as const;

export type SchemaVersionKey = keyof typeof SCHEMA_VERSIONS;
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[SchemaVersionKey];
