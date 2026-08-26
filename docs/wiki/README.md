# 旅行计划信息图系统 Wiki

这套 Wiki 面向第一次接触仓库的开发、测试和运维人员。目标不是重复设计稿，而是回答三个实际问题：

1. 用户看到的每项功能由哪些代码共同完成；
2. 一次请求如何穿过前端、API、队列、Worker、数据库与对象存储；
3. 修改某类能力时，必须同步检查哪些契约、迁移、测试和运维配置。

## 当前系统快照

| 维度         | 当前事实                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 产品         | 自动生成可浏览旅行计划、每日信息图、PNG 长图和 PDF                                                 |
| 技术栈       | Node.js 24、TypeScript、pnpm workspace、Turborepo                                                  |
| Web          | Next.js 15 + React 19                                                                              |
| API          | Fastify 5                                                                                          |
| 异步任务     | BullMQ + Redis，生成队列与导出队列分离                                                             |
| 数据         | PostgreSQL 17 + pgvector；S3/MinIO 对象存储                                                        |
| 渲染         | Playwright Chromium + sharp + pdf-lib                                                              |
| 契约         | `packages/schemas` 中的 Zod 定义是单一真相源                                                       |
| 运行形态     | Linux x86-64/glibc 容器；Windows 可开发但不是正确性基准                                            |
| 规模快照     | 5 个应用、13 个共享包、14 个前向迁移、约 428 个 TS/TSX 文件、151 个测试文件                        |
| 实施状态     | V1 实施计划完成 P0–P8；P9 又完成 Planner V2.1 九步/76 字段、多城与弹性日期；其后接入可开关 CR 计费 |
| 默认身份策略 | `FEATURE_ANONYMOUS_ENABLED=false`，生成前需要注册/登录；匿名实现保留为可回切休眠代码               |
| 默认计费策略 | `CREDIT_BILLING_ENABLED=false`；打开后三个进程共同执行报价、预留、结算、扣费与退款                 |

## 阅读顺序

首次接手建议按以下顺序阅读：

1. [系统架构](01-系统架构.md)：先建立运行时组件与包边界；
2. [端到端主链路](02-端到端主链路.md)：跟随一份计划从提交到导出；
3. [功能与代码映射](03-功能与代码映射.md)：按产品功能定位具体实现；
4. [前端与 API](04-前端与API.md)：理解页面、请求契约、端点和身份；
5. [数据、检索与存储](05-数据检索与存储.md)：理解表关系、向量检索和对象键；
6. [测试、部署与运维](06-测试部署与运维.md)：知道如何验证、启动和排障；
7. [实施状态与已知边界](07-实施状态与已知边界.md)：识别假实现、未实测项和延期项；
8. [开发改动指南](08-开发改动指南.md)：按常见修改类型查看联动清单。

## 按角色快速入口

| 角色/任务            | 优先阅读                                       | 代码起点                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端接入或替换规划器 | [前端与 API](04-前端与API.md)                  | [`Planner.tsx`](../../apps/web/src/components/planner/Planner.tsx)、[`planner-fields.ts`](../../packages/schemas/src/planner-fields.ts)、[`planner-profile.ts`](../../packages/schemas/src/planner-profile.ts) |
| 排查生成失败         | [端到端主链路](02-端到端主链路.md)             | [`apps/generation-worker/src/generate-plan.ts`](../../apps/generation-worker/src/generate-plan.ts)                                                                                                             |
| 修改业务规则         | [功能与代码映射](03-功能与代码映射.md)         | [`packages/planning/src/plan-rules.ts`](../../packages/planning/src/plan-rules.ts)、[`packages/planning/src/conflicts.ts`](../../packages/planning/src/conflicts.ts)                                           |
| 修改信息图模板       | [开发改动指南](08-开发改动指南.md)             | [`apps/web/src/templates/`](../../apps/web/src/templates)                                                                                                                                                      |
| 接入 LLM/图片供应商  | [实施状态与已知边界](07-实施状态与已知边界.md) | [`packages/llm/src/`](../../packages/llm/src)、[`apps/generation-worker/src/assets/model-selection.ts`](../../apps/generation-worker/src/assets/model-selection.ts)                                            |
| 修改素材检索/降级    | [功能与代码映射](03-功能与代码映射.md)         | [`apps/generation-worker/src/assets/resolve-assets.ts`](../../apps/generation-worker/src/assets/resolve-assets.ts)                                                                                             |
| 修改数据库           | [数据、检索与存储](05-数据检索与存储.md)       | [`infrastructure/migrations/`](../../infrastructure/migrations)、[`packages/db/src/`](../../packages/db/src)                                                                                                   |
| 部署与告警排障       | [测试、部署与运维](06-测试部署与运维.md)       | [`deploy/`](../../deploy)、[运维手册](../运维手册.md)                                                                                                                                                          |

## 信息来源与冲突处理

本 Wiki 对照了以下资料：

- [V1.7 详细设计](../旅行计划信息图系统%20V1%20详细设计.md)：解释设计原则、数据契约、状态机、性能和合规目标；
- [V1 实施计划](../旅行计划信息图系统%20V1%20实施计划.md)：记录 P0–P8 的真实交付、偏差和未验证项；
- [P9 Planner V2.1 实施计划](../superpowers/plans/2026-08-24-p9-planner-v2.1-九步问卷与多城行程.md)：记录当前九步/76 字段、多城、弹性日期和实施偏离；
- [用户货币与计费](../用户货币与计费.md)：记录 CR 钱包、价目、预留结算、开关与待定商业定价；
- 当前源码、SQL 迁移、测试、部署清单和根 `package.json`：确认现状；
- [前端接入契约](../前端接入契约.md)、[规划器配置中心](../规划器配置中心.md)、[运维手册](../运维手册.md)：补充实施计划之后的能力。

发生冲突时采用以下优先级：

```text
当前可执行代码/迁移/测试
  > 实施计划末尾的实现说明与偏差
  > V1.7 详细设计
  > README 中的阶段性描述
```

仓库中有两处明显的历史口径：根 README 仍写“当前 P0 完成”，实施计划顶部仍写“P0–P7 完成”，但实施计划末尾明确写 P0–P8 全部完成，且 P8 与后续功能的代码均已存在。因此不要用这两句旧摘要判断进度。

## 核心术语

| 术语                      | 含义                                                                          | 真相源                                      |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| `TravelRequestUI`         | 兼容 P8 核心请求，并可携带 P9 的 `planner_profile`                            | `packages/schemas/src/travel-request.ts`    |
| `PlannerProfile`          | Planner V2.1 九步问卷 76 字段的逐字答案，路径恒为 `planner_profile.{api_key}` | `packages/schemas/src/planner-profile.ts`   |
| `NormalizedTravelRequest` | 计算天数、人数、预算口径和节奏默认值后的请求                                  | 同上 + `packages/planning/src/normalize.ts` |
| `TravelPlan`              | LLM 结构化输出经校验/修复后形成的领域计划                                     | `packages/schemas/src/travel-plan.ts`       |
| `TravelPlanVersion`       | 一次不可变的计划内容版本，也是 UUIDv7 `content_id`                            | `travel_plan_versions`                      |
| `PresentationPlan`        | 每日页和完整页的编排、槽位与内容限额                                          | `packages/presentation`                     |
| `AssetRequirement`        | 页面需要什么素材的声明                                                        | `packages/schemas/src/asset-requirement.ts` |
| `ResolvedAsset`           | 某个素材槽位最终命中、生成、降级或跳过的结果                                  | `packages/schemas/src/resolved-asset.ts`    |
| `TravelPosterViewModel`   | React 每日信息图模板的直接输入                                                | `packages/schemas/src/view-model.ts`        |
| T1                        | 文字计划已保存、13.3 可读                                                     | `generation_jobs.t1_at`                     |
| T2                        | 展示数据与素材完成、13.4 可读                                                 | `generation_jobs.t2_at`                     |
| T3                        | 用户主动请求的 PNG/PDF 导出完成                                               | `exports` 终态                              |
| CR                        | 面向用户的整数计费单位；钱包、冻结额、只追加流水与版本化价目共同工作          | `packages/billing`、`credit_*` 表           |
