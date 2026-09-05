# Fake 编排层测试用例

> **文档类型**：专项说明。回答「fake 模式下每个测试用例验证了什么」。
> **与 Wiki 正文的分工**：[06-测试部署与运维](../06-测试部署与运维.md) 告诉你**在哪、怎么跑**；本文告诉你**每个用例验证的行为与判据**。两边冲突时以代码为准，并回来订正本文。
> **核实方式**：下列全部用例均从测试代码读出并标了行号（核实于 2026-09-05，设计稿见 `docs/superpowers/specs/2026-09-04-fake-asset-resolver-design.md`）。

## 一句话结论

24 个 fake 编排用例覆盖**三条链路**（素材解析、计划生成、渲染）的**延迟、故障、并发与降级**，全部不触碰真实外部服务（数据库、Redis、S3、Chromium、LLM、图源）。

## 一、素材解析层（`apps/generation-worker/src/assets/fakes/`）

### `resolve-assets.full-chain.test.ts`（6 个用例）

| 用例 | 编排 | 验证的行为 | 行号 |
|------|------|-----------|------|
| 逐级命中 | Hero 素材库命中、Photo 搜索命中、Food AI 命中 | 三个槽位从链首各自出发、停在不同环节，互不干扰 | L188-272 |
| 素材库超时降级 | Hero 素材库延迟 1000ms（> 800ms 预算） | 超预算按 miss 处理，继续走搜索层并命中 | L274-314 |
| 搜索连续失败熔断 | Photo 搜索前两次失败、第三次命中 | 验证连续失败计数与恢复（`failTimes` 编排） | L316-371 |
| AI 超时降级 | Food AI 生成超时 | 降级到占位图（`FALLBACK` + `STATIC_DEFAULT`） | L373-411 |
| 全链路降级 | Hero 素材库 miss → 搜索 miss → AI 超时 | 完整降级链走到占位图兜底 | L413-461 |
| 并发隔离 | 两个槽位同时走不同来源 | 编排互不干扰（Hero 走素材库、Photo 走搜索） | L463-530 |

### `resolve-assets.placeholder.test.ts`（5 个用例）

| 用例 | 验证的行为 | 行号 |
|------|-----------|------|
| Hero 占位图 | 素材库 miss → 搜索 miss → AI miss → 渐变背景（`placeholder:v1:hero_background:16x6`） | L187-220 |
| 景点占位图 | 同上 → 默认景点占位图（`placeholder:v1:destination_photo:16x9`） | L222-255 |
| 美食占位图 | 同上 → 默认美食占位图（`placeholder:v1:food_image:4x3`） | L257-290 |
| 占位图缺失 | 占位图未入库时 `SKIPPED`（不是 `FAILED`），必需槽位缺失不阻断任务 | L292-325 |
| 占位图不被命中 | 占位图的 `entity_name` 为 null，不会进 `LOCAL_LIBRARY_MATCH`（只能靠降级链显式取用） | L327-360 |

## 二、计划生成层（`apps/generation-worker/src/generate-plan.full-chain.test.ts`，6 个用例）

| 用例 | 编排 | 验证的行为 | 行号 |
|------|------|-----------|------|
| LLM 延迟 | `wrapLlmWithScript` 按调用次数编排：第一次延迟、第二次成功 | 延迟不阻断任务，计划正常落库 | L160-175 |
| 模型池故障转移 | `wrapLlmFailover`：主候选永不返回、备选成功 | 备选胜出；落库 `llmModel` 是主候选名（包装层），计费口径 `result.model` 是出活者 | L177-207 |
| LLM 全部候选失败 | 所有调用抛 `LlmTimeoutError` | 任务失败，错误码 `PLAN_LLM_TIMEOUT`（可重试） | L209-218 |
| 数据库连接失败 | `findJobContext` 抛错 | 任务直接失败，连第一次状态推进都没发生 | L220-240 |
| 向量化失败 | `wrapEmbedding` 编排 `embed` 抛错 | 不阻断保存：`planEmbedding` 为 `null`，任务照常 `saved` | L242-253 |
| 数据库写入失败 | `savePlanVersion` 抛错 | 任务失败，错误码 `PLAN_PERSIST_FAILED` | L255-270 |

> **「建任务时数据库不可用 → 503」与「Redis 幂等锁不可用 → 唯一索引兜底」在 API 侧**（`travel-plans.ts` 的 fail-open + `UniqueViolationError` 分支），由 API 路由测试覆盖，不在 Worker 的全链路测试里重复。

## 三、渲染层（`apps/render-worker/src/render-worker.full-chain.test.ts`，7 个用例）

| 用例 | 编排 | 验证的行为 | 行号 |
|------|------|-----------|------|
| 浏览器启动失败 | `launch` 抛错 | `holder.get()` 拒绝，任务无法开始 | L82-95 |
| 浏览器启动延迟 | `launch` 编排延迟 | `get()` 在延迟后返回 | L97-110 |
| 页面渲染超时 | 验证编排入口 | 单页 5 秒预算由 `render-page.ts` 的四轮循环兜底（循环本身有其自己的测试） | L112-128 |
| 存储上传失败 | `storage.put` 抛错 | 错误传播而不被吞掉 | L130-153 |
| 存储预签名延迟 | `presign` 编排延迟 | URL 仍返回，过期时刻正确 | L155-168 |
| 浏览器崩溃后重启 | 崩溃后三个并发 `get()` | 只重启一次（R-84：重启串行，并发共用同一次启动） | L170-196 |
| 不存在的任务 | `findById` 返回 null | 静默跳过（保留期清理的尾巴，不让 BullMQ 反复重试） | L198-225 |

## 四、按验证维度归类

### 时序类（延迟/超时不阻断或正确降级）

- 素材库延迟 1000ms 按 miss 处理
- LLM 第一次延迟后成功
- 浏览器启动延迟后返回
- 存储预签名延迟后 URL 仍返回

### 故障类（错误码与降级路径正确）

- AI 生成超时 → 占位图
- LLM 全部失败 → `PLAN_LLM_TIMEOUT`
- 数据库连接失败（读/写两处）
- 浏览器启动失败
- 存储上传失败
- 搜索连续失败熔断（单任务 2 次后停用）

### 并发类

- 两个槽位并发走不同来源互不干扰
- 浏览器崩溃后并发 `get()` 只重启一次

### 数据正确性类

- 占位图三角色各自的缓存键与尺寸
- 占位图缺失时 `SKIPPED` 不是 `FAILED`
- 占位图不会被素材库评分命中（`entity_name` 为 null）
- 故障转移落库 `llmModel` 与计费口径的分工
- 向量化失败写 `planEmbedding: null`
- 不存在任务静默跳过

## 五、已知边界

**fake 是默认值。** 除非显式配 `IMAGE_MODE=direct|gateway` 与真实凭据，否则整条 AI 路径不会被走到 —— 包括候选池、预算闸与故障转移。

**延迟只用于时序断言**，不用于性能测试。`setTimeout` 的精度与真实 IO 不同，编排的延迟只保证「至少等了这么久」，不保证「恰好等了这么久」。

**接口漂移由编译期拦住**：fake 实现继承真实接口，接口加方法时 TypeScript 立刻报错。

## 六、改动联动清单

| 改什么 | 必须同步检查 |
|--------|-------------|
| 加一种 `AssetRole` | `enums.ts`、`placeholders.ts`、fake 编排的 `byRole` 键、测试用例的角色覆盖 |
| 改降级链的顺序 | `resolve-assets.ts` 的 `resolveByRole`、全链路测试的用例顺序 |
| 加新的外部依赖 | 对应包的 fake 实现、`FakeAssetResolverBuilder` 的编排入口 |
| 改 `IMAGE_TIMEOUT_MS` / `IMAGE_JOB_AI_BUDGET_MS` | 候选数上限随之变、T2 告警阈值（155 = 75 + 80）、`IMAGE_SLA_BUDGET_EXCEEDED` 启动日志 |
