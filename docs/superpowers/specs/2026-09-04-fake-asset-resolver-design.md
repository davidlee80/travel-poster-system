# Fake 模拟层设计：全链路测试覆盖

## 一句话设计

为后端**全部外部依赖**（LLM、图片生成、授权图源、素材库、数据库、Redis、队列、存储、浏览器、短信）提供可编排的 fake 实现，通过**装饰器模式**在不改业务代码的前提下注入延迟、故障与命中行为，覆盖全链路测试场景。

## 背景与缺口

当前测试已有 `FakeLlmClient`、`FakeImageClient`、`FakeLicensedSourceClient`、`InMemoryPlanQueue`、`InMemoryObjectStorage`、`InMemoryCreditWalletRepository`、`InMemoryCounterStore`，但**没有**模拟「本地素材库已存在且可命中」的 fake 实现，也**没有**统一的编排入口。

这导致：
- 「素材库命中 → LOCAL_LIBRARY_MATCH」路径在 `resolve-assets.test.ts` 中用**手写假仓储**覆盖，但那个假仓储没有延迟/故障注入能力；
- 「授权图源搜索命中 → LICENSED_SOURCE_MATCH」路径有 fake 客户端，但**没有**模拟「搜索延迟 3 秒后命中」或「连续两次超时后第三次成功」的编排；
- 「AI 生成超时 → 降级到占位图」路径有 `FakeImageClient`，但**没有**模拟「生成 15 秒后超时」的时序；
- **LLM 延迟/故障转移**没有 fake 实现（`FakeLlmClient` 只支持固定响应）；
- **数据库/Redis/队列/存储/浏览器/短信**的延迟与故障没有 fake 实现；
- 最关键的是：**没有**一个统一入口能让测试说「这个槽位走素材库、那个槽位走搜索、另一个槽位走 AI」—— 当前每个测试都要手写整个 `fakeRepo` + `FakeLicensedSourceClient` + `FakeImageClient` 的组合。

## 设计目标

1. **声明式编排**：测试用一行配置表达「这个槽位走素材库、延迟 200ms、成功」；
2. **零业务代码改动**：全部通过装饰器实现，不修改 `resolve-assets.ts` 或任何 resolver；
3. **与现有 fake 客户端共存**：`FakeLlmClient` / `FakeImageClient` / `FakeLicensedSourceClient` 的既有测试**不受影响**；
4. **覆盖全链路**：能测「素材库超时 → 搜索命中 → AI 降级」的完整降级链。

## 覆盖范围校验

### 已覆盖（设计文档中明确）

| 功能点 | 接口/实现 | 状态 |
|--------|----------|------|
| 素材库命中/未命中/延迟/故障 | `AssetsRepository.findCandidates` / `findByCacheKey` | ✅ 已设计 |
| 授权图源搜索命中/延迟/故障 | `LicensedSourceClient.search` / `download` | ✅ 已设计 |
| AI 生成命中/延迟/超时/故障 | `ImageClient.generate` | ✅ 已设计 |
| 统一编排入口 | `FakeAssetResolverBuilder` | ✅ 已设计 |

### 未覆盖（需要补充设计）

| 功能点 | 接口/实现 | 影响 | 建议 |
|--------|----------|------|------|
| **LLM 计划生成** | `LlmClient.complete` | 已有 `FakeLlmClient`，但**没有**模拟「延迟 5 秒后返回」或「第一次失败第二次成功」的编排 | 扩展 `FakeLlmClient` 支持行为脚本 |
| **模型池故障转移** | `wrapLlmFailover` / `wrapImageFailover` | 已有 `FakeLlmClient` / `FakeImageClient`，但**没有**模拟「主候选超时、备选成功」的时序 | 扩展 `FakeLlmClient` / `FakeImageClient` 支持按调用次数编排 |
| **Embedding 向量化** | `EmbeddingClient.embed` | 已有 `LocalHashingEmbeddingClient`，但**没有**模拟「向量化失败」或「延迟 200ms」 | 新增 `FakeEmbeddingClient` |
| **队列（BullMQ）** | `PlanQueue` / `ExportQueue` | 已有 `InMemoryPlanQueue` / `InMemoryExportQueue`，但**没有**模拟「入队失败」或「消费延迟」 | 扩展 `InMemoryPlanQueue` 支持故障注入 |
| **素材锁** | `AssetLock` | 已有 `InMemoryAssetLock`，但**没有**模拟「锁竞争」或「锁超时」 | 扩展 `InMemoryAssetLock` 支持延迟与失败 |
| **对象存储（S3）** | `ObjectStorage` / `ExportStorage` | 已有 `InMemoryObjectStorage` / `InMemoryExportStorage`，但**没有**模拟「上传失败」或「预签名延迟」 | 扩展 `InMemoryObjectStorage` 支持故障注入 |
| **浏览器渲染** | `BrowserHolder` / `renderPage` | 已有 `createBrowserHolder` 的 `launch` 注入点，但**没有**模拟「渲染超时」或「页面加载失败」 | 新增 `FakeBrowserHolder` 与 `FakePage` |
| **短信发送** | `SmsSender` | 已有 `LocalSmsSender`，但**没有**模拟「发送延迟」或「发送失败」 | 扩展 `LocalSmsSender` 支持延迟与失败 |
| **数据库连接池** | `Pool` | 已有 `createPool` 的 `loadDbConfig` 校验，但**没有**模拟「连接耗尽」或「查询超时」 | 新增 `FakePool` 或扩展 `createPool` 支持故障注入 |
| **Redis 连接** | `Redis` | 已有 `createRedis` 与 `createQueueRedis`，但**没有**模拟「连接断开」或「命令超时」 | 新增 `FakeRedis` 或扩展 `createRedis` 支持故障注入 |
| **CR 计费** | `CreditWalletRepository` | 已有 `InMemoryCreditWalletRepository`，但**没有**模拟「预留失败」或「结算延迟」 | 扩展 `InMemoryCreditWalletRepository` 支持故障注入 |
| **配额计数** | `CounterStore` | 已有 `InMemoryCounterStore`，但**没有**模拟「计数失败」或「延迟」 | 扩展 `InMemoryCounterStore` 支持故障注入 |

## 素材库设计逻辑（2026-09-04 补充）

### 三条图片链的降级路径

| 槽位 | 降级链 | 占位图 |
|------|--------|--------|
| Hero | 缓存键命中 → 素材库 → 授权图源搜索 → AI 生成 → 默认渐变背景 | `placeholder:v1:hero_background:16x6` |
| 景点图 | 缓存键命中 → 素材库 → 授权图源搜索 → AI 生成 → 默认景点占位图 | `placeholder:v1:destination_photo:16x9` |
| 美食图 | 缓存键命中 → 素材库 → 授权图源搜索 → AI 生成 → 默认美食占位图 | `placeholder:v1:food_image:4x3` |

### 关键约束

1. **三个素材库都需要建立**：Hero、景点、美食各自独立的缓存键与检索路径；
2. **全链路降级**：素材库 miss → 搜索 miss → AI 超时 → 占位图；
3. **搜索层可缺省**：装配搜索层时三类槽位统一走「素材库 → 搜索 → AI → 占位图」；搜索层（`licensedSource`）未装配的部署跳过该环，降级链是「素材库 → AI → 占位图」（AI 层同理可缺省，见对照表）；
4. **占位图必须预先入库**：`assets:ingest --placeholders` 是部署前置步骤，缺失时降级链的最后一环无处可取。

### 与现有实现的对照

| 设计稿 | 当前实现 | 状态 |
|--------|---------|------|
| 缓存键命中 → 素材库 → 授权图源搜索 → AI 生成 → 默认占位 | `resolve-assets.ts` 的 `resolveByRole` | ✅ 一致 |
| 搜索层可选（未装配时跳过） | `deps.licensedSource === undefined` 时跳过 | ✅ 一致 |
| AI 层可选（未装配时跳过） | `deps.ai === undefined` 时跳过 | ✅ 一致 |
| 占位图预先入库 | `placeholders.ts` 的 `PLACEHOLDER_SPECS` | ✅ 一致 |
| 占位图缺失时 SKIPPED | `fallback.ts` 的 `resolveFallback` | ✅ 一致 |

**结论**：当前实现与设计稿一致，无需修改。

## 修订后的架构：五层装饰器

```text
测试代码
  ↓
FakeAssetResolverBuilder          ← 声明式编排入口（素材解析）
FakeInfraBuilder                  ← 声明式编排入口（基础设施）
  ↓
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ FakeLocalLibrary│ FakeLicensedSource│ FakeAiGenerator│ FakeLlmClient   │ FakeInfraLayer │
│  (延迟+命中)    │  (延迟+故障)      │  (延迟+超时)     │  (延迟+故障)     │  (延迟+故障)     │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┘
  ↓
真实 resolve-assets.ts / generate-plan.ts / main.ts  ← 业务代码不变
```

### 第五层：FakeInfraLayer（基础设施）

**职责**：模拟数据库、Redis、队列、存储、浏览器、短信的延迟/故障。

**接口**：
```typescript
interface FakeInfraOptions {
  readonly database?: FakeDatabaseBehavior;
  readonly redis?: FakeRedisBehavior;
  readonly queue?: FakeQueueBehavior;
  readonly storage?: FakeStorageBehavior;
  readonly browser?: FakeBrowserBehavior;
  readonly sms?: FakeSmsBehavior;
}

interface FakeDatabaseBehavior {
  readonly connectionDelayMs?: number;
  readonly queryDelayMs?: number;
  readonly connectionError?: Error;
  readonly queryError?: Error;
}

interface FakeRedisBehavior {
  readonly commandDelayMs?: number;
  readonly connectionError?: Error;
  readonly commandError?: Error;
}

interface FakeQueueBehavior {
  readonly enqueueDelayMs?: number;
  readonly consumeDelayMs?: number;
  readonly enqueueError?: Error;
}

interface FakeStorageBehavior {
  readonly uploadDelayMs?: number;
  readonly downloadDelayMs?: number;
  readonly uploadError?: Error;
  readonly presignDelayMs?: number;
}

interface FakeBrowserBehavior {
  readonly launchDelayMs?: number;
  readonly renderDelayMs?: number;
  readonly launchError?: Error;
  readonly renderError?: Error;
}

interface FakeSmsBehavior {
  readonly sendDelayMs?: number;
  readonly sendError?: Error;
}
```

**实现**：包装各基础设施接口，在方法调用时注入延迟/故障。

## 修订后的实现文件

```
apps/generation-worker/src/assets/fakes/
├── fake-local-library.ts        # 素材库 fake
├── fake-licensed-source.ts      # 授权图源 fake
├── fake-ai-generator.ts         # AI 生成 fake
├── fake-asset-resolver.ts       # 统一编排入口（素材解析）
└── index.ts                     # 导出

apps/api/src/fakes/
├── fake-database.ts             # 数据库 fake
├── fake-redis.ts                # Redis fake
├── fake-queue.ts                # 队列 fake
├── fake-storage.ts              # 存储 fake
├── fake-sms.ts                  # 短信 fake
├── fake-infra.ts                # 统一编排入口（基础设施）
└── index.ts                     # 导出

apps/render-worker/src/fakes/
├── fake-browser.ts              # 浏览器 fake
└── index.ts                     # 导出
```

## 修订后的测试用例

新增 `resolve-assets.full-chain.test.ts`（素材解析全链路）。

所有用例基于同一条统一降级链 —— Hero、景点、美食三类槽位规则一致：**素材库匹配 → 授权图源搜索 → AI 生成 → 占位图兜底**（缓存键命中是素材库之前的精确键快捷路径；搜索层与 AI 层均可缺省，缺省时跳过该环）。每个用例通过编排让槽位停在链的不同环节，或验证相邻环节之间的降级行为，不存在「某类槽位固定走某个来源」的特例：

1. **逐级命中**：三个槽位从链首各自出发、停在不同环节——Hero 素材库命中即返回；Photo 素材库 miss → 搜索命中；Food 素材库 miss → 搜索 miss → AI 命中；
2. **素材库超时降级**：Hero 素材库延迟 1000ms（> 800ms 检索预算）按 miss 处理，继续走搜索层并命中；
3. **搜索连续失败熔断**：连续两个槽位搜索超时触发熔断（9.6：搜索层单槽位内不重试，单任务连续失败 2 次即跳过搜索层），第三个槽位起不再发起搜索，直接降入 AI → 占位图；
4. **AI 超时降级**：Food 素材库 miss → 搜索 miss → AI 生成 15 秒超时 → 占位图；
5. **全链路降级**：Hero 素材库 miss → 搜索 miss → AI 超时 → 占位图；
6. **并发隔离**：两个槽位并发各自走统一降级链、停在不同环节，互不干扰。

新增 `generate-plan.full-chain.test.ts`（计划生成全链路）：
1. **LLM 延迟**：LLM 第一次延迟 5 秒，第二次成功；
2. **模型池故障转移**：主候选超时，备选成功；
3. **数据库连接失败**：建任务时数据库不可用，返回 503；
4. **Redis 连接失败**：幂等锁不可用，走唯一索引兜底。

新增 `render-worker.full-chain.test.ts`（渲染全链路）：
1. **浏览器启动失败**：Chromium 启动失败，返回 503；
2. **页面渲染超时**：渲染超过 5 秒，降级到宽松版式；
3. **存储上传失败**：PNG 上传失败，导出任务失败。

## 风险与回滚

- **风险**：`FakeAssetResolverBuilder` 的编排表与真实 resolver 的接口漂移。
  - **缓解**：编排表的 key 就是 `AssetRole` 枚举，编译期检查；
  - **回滚**：删除 `fakes/` 目录，恢复手写假仓储。

- **风险**：fake 层的延迟模拟不准确（`setTimeout` vs 真实 IO）。
  - **缓解**：延迟只用于测试时序断言，不用于性能测试；
  - **回滚**：延迟改为 0，只保留命中/故障编排。

- **风险**：基础设施 fake 与真实实现的接口漂移（如 `Pool` 的 `query` 方法签名变化）。
  - **缓解**：fake 实现**继承**真实接口，编译期检查；
  - **回滚**：删除 `fakes/` 目录，恢复真实实现。

## 下一步

1. 实现 `apps/generation-worker/src/assets/fakes/` 目录下的四个文件；
2. 实现 `apps/api/src/fakes/` 目录下的七个文件；
3. 实现 `apps/render-worker/src/fakes/` 目录下的两个文件；
4. 编写 `resolve-assets.full-chain.test.ts`、`generate-plan.full-chain.test.ts`、`render-worker.full-chain.test.ts`；
5. 验证全部既有测试不受影响；
6. 更新 `docs/wiki/06-测试部署与运维.md` 的测试策略章节。

## 架构：三层装饰器

```text
测试代码
  ↓
FakeAssetResolverBuilder          ← 声明式编排入口
  ↓
┌─────────────────┬─────────────────┬─────────────────┐
│ FakeLocalLibrary│ FakeLicensedSource│ FakeAiGenerator│  ← 各层独立可组合
│  (延迟+命中)    │  (延迟+故障)      │  (延迟+超时)     │
└─────────────────┴─────────────────┴─────────────────┘
  ↓
真实 resolve-assets.ts            ← 业务代码不变
```

### 第一层：FakeLocalLibrary（素材库）

**职责**：模拟 `AssetsRepository.findCandidates` 与 `findByCacheKey` 的命中/未命中/延迟/故障。

**接口**：
```typescript
interface FakeLocalLibraryOptions {
  /** 按槽位角色编排行为 */
  readonly byRole?: Partial<Record<AssetRole, FakeLocalLibraryBehavior>>;
  /** 全局默认行为 */
  readonly default?: FakeLocalLibraryBehavior;
}

interface FakeLocalLibraryBehavior {
  /** 命中：返回候选列表 */
  readonly hit?: readonly AssetCandidateRow[];
  /** 未命中：返回空列表 */
  readonly miss?: boolean;
  /** 延迟毫秒数（模拟数据库查询慢） */
  readonly delayMs?: number;
  /** 故障：抛错（模拟数据库连接失败） */
  readonly error?: Error;
}
```

**实现**：包装 `AssetsRepository`，在 `findCandidates` / `findByCacheKey` 里按 `item.role` 查编排表。

### 第二层：FakeLicensedSource（授权图源搜索）

**职责**：模拟 `LicensedSourceClient.search` 与 `download` 的命中/未命中/延迟/故障。

**接口**：
```typescript
interface FakeLicensedSourceOptions {
  readonly byRole?: Partial<Record<AssetRole, FakeSearchBehavior>>;
  readonly default?: FakeSearchBehavior;
}

interface FakeSearchBehavior {
  /** 命中：返回候选列表 */
  readonly candidates?: readonly LicensedSourceCandidate[];
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障：'timeout' | 'unavailable' */
  readonly error?: 'timeout' | 'unavailable';
  /**
   * 连续失败次数（按角色跨调用累计）：用于编排「连续失败触发熔断」的场景。
   * 注意这与单槽位重试无关 —— 搜索层在单槽位内不重试（9.6：超时即降入 AI 层），
   * 且单任务连续失败 2 次后熔断，之后的搜索根本不会再发起。
   */
  readonly failTimes?: number;
}
```

**实现**：包装 `LicensedSourceClient`，在 `search` / `download` 里按 `query.role` 查编排表。

### 第三层：FakeAiGenerator（AI 生成）

**职责**：模拟 `ImageClient.generate` 的命中/延迟/超时/故障。

**接口**：
```typescript
interface FakeAiGeneratorOptions {
  readonly byRole?: Partial<Record<AssetRole, FakeAiBehavior>>;
  readonly default?: FakeAiBehavior;
}

interface FakeAiBehavior {
  /** 成功：返回图片字节 */
  readonly bytes?: Uint8Array;
  /** 延迟毫秒数 */
  readonly delayMs?: number;
  /** 故障：'timeout' | 'unavailable' */
  readonly error?: 'timeout' | 'unavailable';
}
```

**实现**：包装 `ImageClient`，在 `generate` 里按 `request.role` 查编排表。

## 统一编排入口

```typescript
class FakeAssetResolverBuilder {
  /** 素材库行为 */
  localLibrary(options: FakeLocalLibraryOptions): this;
  /** 授权图源行为 */
  licensedSource(options: FakeLicensedSourceOptions): this;
  /** AI 生成行为 */
  aiGenerator(options: FakeAiGeneratorOptions): this;
  /** 构造 ResolveAssetsDeps */
  build(): ResolveAssetsDeps;
}
```

**用法示例**：
```typescript
const deps = new FakeAssetResolverBuilder()
  .localLibrary({
    byRole: {
      HERO_BACKGROUND: { hit: [heroAsset], delayMs: 100 },
      DESTINATION_PHOTO: { miss: true },
    },
    default: { miss: true },
  })
  .licensedSource({
    byRole: {
      DESTINATION_PHOTO: { candidates: [photoCandidate], delayMs: 3000 },
    },
    default: { error: 'timeout' },
  })
  .aiGenerator({
    byRole: {
      FOOD_IMAGE: { bytes: foodImageBytes, delayMs: 15000 }, // 超时
    },
    default: { error: 'unavailable' },
  })
  .build();

const result = await resolveAssets(deps, envelope);
```

**角色路由（2026-09-05 起生效）**：生产调用在 `findCandidates` / `search` / `generate`
的入参里携带 `role`（`FindCandidatesQuery.role` / `LicensedSourceQuery.role` /
`ImageRequest.role`，均为可选字段，真实实现忽略），fake 直接读它做按角色编排。
不带 `role` 的直接调用退化为按槽位约束判定（搜索/AI 按比例、素材库按 `entityName`
是否为 null），不再从提示词或检索词里猜 —— 关键词嗅探曾让 AI 层的按角色编排
全部静默落进 `DESTINATION_PHOTO` 分支。

## 与现有测试的关系

| 现有测试 | 是否受影响 | 理由 |
|---------|-----------|------|
| `resolve-assets.test.ts` 的「素材库命中」用例 | **不受影响** | 手写假仓储仍然可用 |
| `resolve-assets.test.ts` 的「搜索超时」用例 | **不受影响** | `FakeLicensedSourceClient` 的行为脚本仍然可用 |
| `preheat.integration.test.ts` | **不受影响** | 不经过 fake 模拟层 |
| 新增的「全链路降级」用例 | **新增** | 用 `FakeAssetResolverBuilder` 编排 |

## 实现文件

```
apps/generation-worker/src/assets/fakes/
├── fake-local-library.ts      # 素材库 fake
├── fake-licensed-source.ts    # 授权图源 fake
├── fake-ai-generator.ts       # AI 生成 fake
├── fake-asset-resolver.ts     # 统一编排入口
└── index.ts                   # 导出
```

## 测试用例

新增 `resolve-assets.full-chain.test.ts`（素材解析全链路）。

所有用例基于同一条统一降级链 —— Hero、景点、美食三类槽位规则一致：**素材库匹配 → 授权图源搜索 → AI 生成 → 占位图兜底**（缓存键命中是素材库之前的精确键快捷路径；搜索层与 AI 层均可缺省，缺省时跳过该环）。每个用例通过编排让槽位停在链的不同环节，或验证相邻环节之间的降级行为，不存在「某类槽位固定走某个来源」的特例：

1. **逐级命中**：三个槽位从链首各自出发、停在不同环节——Hero 素材库命中即返回；Photo 素材库 miss → 搜索命中；Food 素材库 miss → 搜索 miss → AI 命中；
2. **素材库超时降级**：Hero 素材库延迟 1000ms（> 800ms 检索预算）按 miss 处理，继续走搜索层并命中；
3. **搜索连续失败熔断**：连续两个槽位搜索超时触发熔断（9.6：搜索层单槽位内不重试，单任务连续失败 2 次即跳过搜索层），第三个槽位起不再发起搜索，直接降入 AI → 占位图；
4. **AI 超时降级**：Food 素材库 miss → 搜索 miss → AI 生成 15 秒超时 → 占位图；
5. **全链路降级**：Hero 素材库 miss → 搜索 miss → AI 超时 → 占位图；
6. **并发隔离**：两个槽位并发各自走统一降级链、停在不同环节，互不干扰。

新增 `resolve-assets.placeholder.test.ts`（占位图专项）：

1. **Hero 占位图**：素材库 miss → 搜索 miss → AI miss → 渐变背景；
2. **景点占位图**：素材库 miss → 搜索 miss → AI miss → 默认景点占位图；
3. **美食占位图**：素材库 miss → 搜索 miss → AI miss → 默认美食占位图；
4. **占位图缺失**：占位图未入库时 SKIPPED（不是 FAILED）；
5. **占位图不被命中**：占位图的 `entity_name` 为 null，不会进 `LOCAL_LIBRARY_MATCH`。

## 风险与回滚

- **风险**：`FakeAssetResolverBuilder` 的编排表与真实 resolver 的接口漂移。
  - **缓解**：编排表的 key 就是 `AssetRole` 枚举，编译期检查；
  - **回滚**：删除 `fakes/` 目录，恢复手写假仓储。

- **风险**：fake 层的延迟模拟不准确（`setTimeout` vs 真实 IO）。
  - **缓解**：延迟只用于测试时序断言，不用于性能测试；
  - **回滚**：延迟改为 0，只保留命中/故障编排。

## 下一步

1. 实现 `fakes/` 目录下的四个文件；
2. 编写 `resolve-assets.full-chain.test.ts` 与 `resolve-assets.placeholder.test.ts`；
3. 验证全部既有测试不受影响；
4. 更新 `docs/wiki/06-测试部署与运维.md` 的测试策略章节。
