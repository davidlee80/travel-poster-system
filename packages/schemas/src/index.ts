/**
 * 五大数据契约的单一真相源（设计稿四章、22.1）。
 *
 * 这个包是整个系统最重要的一致性机制：API、Worker 与 React 模板全部从这里
 * 导入类型，因此 `TravelPosterViewModel` 与模板之间的字段不一致会变成
 * **编译错误**而不是运行期空白。设计稿 V1.0 在这一处出现过三个字段级
 * 不一致（见 6.2、12.2），单一真相源就是为了让同类问题不再复发。
 *
 * 交付节奏（见实施计划）：
 *   P1  TravelPlan + 全部枚举 + TravelPosterViewModel  ← 已完成
 *   P2  TravelRequestUI、NormalizedTravelRequest、条件字典（TP-2-03）  ← 已完成
 *   P3  AssetRequirement、ResolvedAsset（TP-3-02）                    ← 已完成
 *   P4  VisualBrief、GenerationMetadata、导出契约（TP-4-01/04/12）    ← 已完成
 *
 * 约束：本包**不得引入除 zod 以外的运行时依赖** —— 它被所有应用引用，
 * 任何额外依赖都会成为全仓库的版本冲突面。
 */

export { SCHEMA_VERSIONS, type SchemaVersion, type SchemaVersionKey } from './versions.js';

export * from './enums.js';
export * from './primitives.js';
export * from './conditions.js';
export * from './planner-fields.js';
export * from './planner-profile.js';
export * from './travel-request.js';
export * from './error-codes.js';
export * from './travel-plan.js';
export * from './retrieval-projection.js';
export * from './asset-requirement.js';
export * from './resolved-asset.js';
export * from './ai-asset.js';
export * from './export.js';
export * from './job-status.js';
export * from './view-model.js';
export { travelPlanJsonSchema, travelPlanLlmOutputJsonSchema } from './json-schema.js';
export { TRAVEL_PLAN_FIXTURES, makeTravelPlanFixture, type FixtureOptions } from './fixtures.js';
