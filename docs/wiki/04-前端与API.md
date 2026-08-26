# 前端与 API

## Web 路由

| 路由                                             | 用途                       | 数据来源                                | 访问边界     |
| ------------------------------------------------ | -------------------------- | --------------------------------------- | ------------ |
| `/`                                              | Planner V2.1 九步旅行问卷  | planner config + session + 本机草稿状态 | 公网         |
| `/credits`                                       | CR 余额与消费流水          | credits wallet/ledger API               | 注册用户     |
| `/plans/[planId]`                                | 文字计划、信息图入口、导出 | 公网计划/展示/导出 API                  | 当前用户     |
| `/legal`                                         | 用户协议与隐私政策         | 构建期读取 `docs/用户协议与隐私政策.md` | 公网         |
| `/render/plans/[planVersionId]/full`             | 完整计划内部渲染页         | API 内部 presentation                   | HMAC，仅内部 |
| `/render/plans/[planVersionId]/days/[dayNumber]` | 单日内部渲染页             | API 内部 presentation                   | HMAC，仅内部 |

`/render/**` 由 [`middleware.ts`](../../apps/web/src/middleware.ts) 和 [`render-token-edge.ts`](../../apps/web/src/lib/render-token-edge.ts) 校验短期签名。普通浏览器直接访问应得到 404，不要把它当用户预览页面。

## 公网 API 清单

### 身份与配置

| 方法与路径                   | 请求                                   | 成功响应                     | 代码                           |
| ---------------------------- | -------------------------------------- | ---------------------------- | ------------------------------ |
| `GET /api/v1/auth/session`   | Cookie                                 | 当前身份、账号字段、剩余配额 | `routes/auth.ts`               |
| `POST /api/v1/auth/register` | 手机+验证码，或兼容 email+password     | 201 会话并写 Cookie          | 同上                           |
| `POST /api/v1/auth/login`    | 手机验证码/密码，或兼容 email+password | 200 会话                     | 同上                           |
| `POST /api/v1/auth/sms/send` | `{phone,purpose}`                      | 冷却/有效期信息              | 同上 + `phone-verification.ts` |
| `POST /api/v1/auth/logout`   | Cookie                                 | 204，撤销当前会话            | 同上                           |
| `POST /api/v1/auth/password` | 当前密码+新密码                        | 204，并撤销其他会话          | 同上                           |
| `GET /api/v1/planner/config` | 无                                     | 发布版版本、字段选项         | `routes/planner-config.ts`     |

当前代码已经支持手机账号，而早期 [前端接入契约](../前端接入契约.md) 的身份表仍只列 email。接入身份时应以 `routes/auth.ts` 的 Zod Schema 和 Web `AuthPanel.tsx` 为准。手机号统一转为中国 E.164 `+86...`。

### 计划生成与读取

| 方法与路径                                                    | 责任                         | 返回/注意点                                         |
| ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| `POST /api/v1/travel-plans/generate`                          | 校验、标准化、幂等创建并入队 | 201；返回 `request_id/plan_id/job_id/status`        |
| `GET /api/v1/generation-jobs/:job_id`                         | 轮询状态                     | `status/progress/message/warnings/error/milestones` |
| `POST /api/v1/generation-jobs/:job_id/cancel`                 | 取消非终态任务               | 已终态按路由语义返回当前结果/冲突                   |
| `GET /api/v1/travel-plans/:plan_id`                           | 读取当前可用计划 JSON        | `REJECTED` 不暴露；T1 后可读                        |
| `GET /api/v1/travel-plans/:plan_id/presentations/full`        | 完整页 ViewModel             | T2 后可读；可带版本查询参数                         |
| `GET /api/v1/travel-plans/:plan_id/presentations/:day_number` | 单日 ViewModel               | 日序号合法且属于当前用户                            |
| `GET /api/v1/travel-plans`                                    | 当前用户计划列表             | `(created_at,id)` 复合游标分页；前端列表 UI 尚未做  |

### 导出

| 方法与路径                                   | 责任                 | 返回/注意点                             |
| -------------------------------------------- | -------------------- | --------------------------------------- |
| `POST /api/v1/travel-plans/:plan_id/exports` | 创建导出任务         | 201；幂等命中/并发竞态时 200 返回原任务 |
| `GET /api/v1/exports/:export_id`             | 查询结果并签下载 URL | 只按数据库归属授权；完成文件 URL 可重签 |

### CR 钱包（仅计费开关打开时注册）

| 方法与路径                   | 请求                       | 响应/语义                                                |
| ---------------------------- | -------------------------- | -------------------------------------------------------- |
| `GET /api/v1/credits/wallet` | 注册会话                   | `balance_cr/held_cr/balance_cny`                         |
| `POST /api/v1/credits/quote` | `{total_days: 1..14}`      | 价目版本、典型/上界/预留 CR 与人民币、余额、`sufficient` |
| `GET /api/v1/credits/ledger` | `limit`、时间游标 `before` | 倒序只追加流水；不下发含供应商模型和单价的 metadata      |

三个端点都拒绝匿名。报价只收天数，便于表单尚未完成时展示；生成端点会按权威标准化天数重新报价和原子预留，客户端少报天数不能少扣费。余额不足返回 402 `AUTH_INSUFFICIENT_CREDITS`，错误 details 带 required/balance CR。

导出请求真相源是 [`CreateExportRequestSchema`](../../packages/schemas/src/export.ts)，支持目标页和格式组合。导出状态为 `QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED`，不复用生成任务状态。

## 内部 API

| 方法与路径                                                     | 调用方            | 用途                                                    |
| -------------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| `GET /internal/v1/plan-versions/:id/presentations/full`        | Web 内部渲染页    | 按版本取完整 ViewModel                                  |
| `GET /internal/v1/plan-versions/:id/presentations/:day_number` | Web 内部渲染页    | 按版本取单日 ViewModel                                  |
| `POST /internal/v1/maps/render-schematic`                      | 内部/测试兼容入口 | 调用 `@tps/assets` 生成路线 SVG；主 Worker 走进程内函数 |

内部端点用共享密钥验证。它们刻意不带用户会话，按计划版本读取，所以不能暴露到公网代理规则中。

## 通用 HTTP 约定

- 用户资源的 SQL 查询必须含 `user_id`，不存在与越权均返回 404，避免枚举资源。
- 错误体由 `apps/api/src/errors/codes.ts` 构建，领域码定义在 `packages/schemas/src/error-codes.ts`。
- `retryable` 是服务端判定，不由前端猜测；429 会带 `Retry-After`。
- 请求 ID 由 Fastify 生成/透传，Trace ID 由 OTel 提供；不得把 Cookie、token、完整请求或计划写日志。
- 生成与导出都具备应用层幂等和数据库唯一约束，客户端重试应复用同一个意图 ID。

## `TravelRequestUI` 与 Planner V2.1

### 兼容层的 11 个真正必填字段

| 字段                    | 原因                                |
| ----------------------- | ----------------------------------- |
| `schema_version`        | 契约判别式，不能把未来版本静默当 v1 |
| `client_request_id`     | 用户意图级幂等键                    |
| `timezone`              | N-01 的“今天”需要用户时区           |
| `trip.origin.text`      | 出发地                              |
| `trip.destination.text` | 单一固定目的地                      |
| `trip.dates.start_date` | 起始日期                            |
| `trip.dates.end_date`   | 结束日期                            |
| `travelers.adults`      | 人数与预算计算                      |
| `budget.basis`          | 决定金额是人均每天还是全程总额      |
| `budget.min`            | 预算下限                            |
| `budget.max`            | 预算上限                            |

其余核心值由 [`TravelRequestUISchema`](../../packages/schemas/src/travel-request.ts) 默认。P9 没有破坏这层契约，而是增加可选 `planner_profile`：旧 P8 客户端仍合法，新前端把 76 个答案逐字保存到该块，并投影出这 11 个核心字段。

对象级默认必须使用 Zod `.prefault({})`，数组默认使用返回新数组的函数。原因是 Zod 4 的 `.default()` 会短路内部解析且可能复用引用；仓库测试专门防止这类“类型看起来有字段，运行时却是空对象”的问题。

### 76 字段问卷

[`PLANNER_FIELDS`](../../packages/schemas/src/planner-fields.ts) 是字段元数据真相源，包含 76 个唯一 Field ID/API key、9 个主步骤、运行时控件类型、必填/条件、阻断级别、敏感度、优先级、摘要分组和约束类型。生成后的第 10 步“行前准备中心”包含 6 个 POST_PLAN 字段，不在主问卷生成闸门中。

[`PlannerProfileSchema`](../../packages/schemas/src/planner-profile.ts) 的 19 个子块逐字保存答案。仓库用测试保证：

```text
每个字段的载荷路径 = planner_profile + "." + api_key
```

这样 `budget.travel_tier` 与兼容层 `budget.tier` 等同义路径不会互相覆盖，也无需维护易漂移的别名表。`buildPlannerRequest` 负责单向投影；原始答案保留用于运行时约束、摘要和未来能力。

当前 9 步依次为：旅行轮廓、同行伙伴、预算取舍、旅行节奏、路上怎么走、住得更舒服、吃好也玩好、特别关照、确认旅程。支持 1～5 个有序目的地、6 种币种和最多 30 天的弹性描述；目的地首项必须与兼容字段一致。

### 标准化派生

[`normalizeTravelRequest`](../../packages/planning/src/normalize.ts) 计算：

- `total_days`（含首尾两天）；
- `traveler_count`；
- 按原币种统一到人均每天与全程总预算，不在线换汇；
- pace 的 level/intensity、每日景点数、步行上限和休息分钟默认；
- 规范化目的地、条件与自由文本。

### 条件三态与 61 个内置代码

条件形态为 `{code, mode, value}`：

| UI   | 合同表示        | 语义             |
| ---- | --------------- | ---------------- |
| 偏好 | `SHOULD + true` | 尽量满足，可牺牲 |
| 必须 | `MUST + true`   | 硬约束           |
| 不要 | `MUST + false`  | 硬性排除         |

合法代码集中在 [`conditions.ts`](../../packages/schemas/src/conditions.ts)，P8 的 46 项在 P9 扩到 61 项，仍按七域组织。运行期 Schema 接受合法域格式，但 API 在有发布配置时用配置中心白名单裁决具体 code；所以新增内置码必须同时进入配置迁移并发布，否则 UI 看似正常、提交却被 N-08 拒绝。

## 前端轮询策略

[`GenerationDialog.tsx`](../../apps/web/src/components/planner/GenerationDialog.tsx) 与 [`generation-dialog.ts`](../../apps/web/src/lib/generation-dialog.ts) 负责：

1. 提交后保存 `job_id` 和 `plan_id`；
2. 轮询任务状态；
3. 使用服务端 `progress/message`，不在前端复制状态映射；
4. T1 后可提前读取文字计划；T2/完成后进入计划页；
5. 对 401 显示登录引导，对 429 尊重 `Retry-After`，对不可重试错误提示用户修改输入；
6. 取消调用专用端点，而不是仅关闭弹窗。

## 规划器配置中心

数据库迁移 `0010` 创建版本机制，`0011` 发布 P9 新条件，`0012` 把九步问卷全部选项纳入配置并改用载荷路径 field_key。API 只返回唯一 `PUBLISHED` 版本，响应：

- `Cache-Control: public, max-age=60, stale-while-revalidate=300`；
- `ETag: "planner-config-{version}"`；
- 无发布版时 503 `SYS_DEPENDENCY_UNAVAILABLE`；
- 只返回 `enabled=true`，按字段、排序号、机器码稳定排序。

运维修改方法见 [规划器配置中心](../规划器配置中心.md)。

## API 改动的最小联动集

新增/修改公网字段或端点时至少检查：

```text
packages/schemas
→ apps/api route + repository interface
→ apps/web api-client/form/UI
→ fake repository 和 route test
→ 前端接入契约/字段清单
→ acceptance-gates（若属于验收行为）
```
