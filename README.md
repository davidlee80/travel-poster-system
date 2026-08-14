# 旅行计划信息图系统

自动生成旅行计划的可浏览 HTML、每日信息图、PNG 长图与 PDF。全链路无需人工介入。

```text
用户提交旅行诉求 → 后端标准化 → 大模型生成结构化计划 → 程序校验并自动修复
→ 展示编排 → 素材服务（图片/图标/地图）→ ViewModel → React 模板渲染 HTML
→ Playwright 导出 PNG/PDF → 展示给用户
```

**工程真相源**：[docs/旅行计划信息图系统 V1 详细设计.md](docs/旅行计划信息图系统%20V1%20详细设计.md)（V1.2）
**实施计划与进度**：[docs/旅行计划信息图系统 V1 实施计划.md](docs/旅行计划信息图系统%20V1%20实施计划.md)

当前阶段：**P0 已完成**（仓库骨架、基础设施、Linux 护栏与 CI）。P1 起实现渲染链路与身份体系。

## 环境要求

| 工具   | 版本         | 说明                                     |
| ------ | ------------ | ---------------------------------------- |
| Node   | 24 LTS       | `engines` 已声明并启用 `engine-strict`   |
| pnpm   | ≥ 10         | `corepack enable`，或 `npm i -g pnpm@10` |
| Docker | 任意近期版本 | 本地 PostgreSQL / Redis / MinIO          |

**运行平台是 Linux。** 开发可以在 Windows / macOS，但只有 Linux CI 全绿才算通过 —— 详见设计稿 22.3 与下方「跨平台护栏」。

## 快速开始

```bash
pnpm install
cp env.example .env

pnpm infra:up        # PostgreSQL(pgvector) + Redis + MinIO
pnpm db:migrate      # 应用迁移
pnpm db:status       # 查看迁移状态

pnpm build
pnpm test
```

## 常用命令

| 命令                                          | 作用                   |
| --------------------------------------------- | ---------------------- |
| `pnpm build`                                  | 全量构建               |
| `pnpm typecheck`                              | 类型检查（含测试文件） |
| `pnpm lint`                                   | ESLint                 |
| `pnpm test`                                   | Vitest                 |
| `pnpm format` / `format:check`                | Prettier               |
| `pnpm verify:linux-guardrails`                | 跨平台护栏反向测试     |
| `pnpm infra:up` / `infra:down` / `infra:logs` | 本地基础设施           |
| `pnpm db:migrate` / `db:status`               | 数据库迁移             |

## 仓库结构

```text
apps/
  web/                 Next.js：用户界面 + 内部渲染路由 + React 模板
  api/                 Fastify：REST /api/v1
  generation-worker/   计划生成、展示编排、素材解析
  render-worker/       Playwright：HTML → PNG/PDF（独立镜像，含 Chromium 与中文字体）
  retention-worker/    匿名数据保留期清理 + 行程知识转存
packages/
  schemas/             五大契约的单一真相源（Zod）
  shared/              优雅停机、Worker 运行时、结构化日志、配置
  observability/       Prometheus 指标 + OTel 埋点
  db/                  连接池 + 前向单向迁移
infrastructure/
  docker-compose.yml   本地基础设施
  migrations/          版本化 SQL 迁移
deploy/images/         五个生产 Dockerfile
tools/                 ESLint 本地规则、护栏反向测试
docs/                  设计稿与实施计划
```

`packages/icon-library` 与 `packages/fonts` 在 P1 随内容一起建立 —— 空包会进入构建图却无任何产出。

## 工程约束

### 契约先行

`packages/schemas` 是 API、Worker 与 React 模板共同的类型来源。`TravelPosterViewModel` 与模板之间的字段不一致会成为**编译错误**而不是运行期空白 —— 设计稿 V1.0 在这一处出现过三个字段级不一致（见设计稿 6.2、12.2），单一真相源就是为了让同类问题不再复发。

本包**不引入除 zod 以外的运行时依赖**：它被所有应用引用，任何额外依赖都会成为全仓库的版本冲突面。

### 数据库迁移只前向

不写 `down`。破坏性变更走 expand-backfill-contract 三步，每步是独立的前向迁移；回滚靠部署上一版应用代码。已应用的迁移文件不可修改 —— 执行器记录校验和，文件被改时报错而非静默跳过。详见 [infrastructure/migrations/README.md](infrastructure/migrations/README.md)。

### 指标标签有白名单，且由类型强制

高基数标签打爆 Prometheus 是不可逆的生产事故（内存暴涨 → 抓取超时 → 监控盲区，恰好在最需要监控的时候）。因此 `user_id`、`email`、`plan_id`、`trace_id` 等**不能**作为指标标签，`user_type` 可以（只有两个取值）。

约束写在类型里而不是 lint 规则里 —— 类型检查无法用 `eslint-disable` 绕过：

```ts
createCounter({ name: 'x', help: '', labelNames: ['user_id'] });
//                                                 ^^^^^^^^^ 编译错误，含明确说明
```

这些 ID 属于**日志与 trace** 的职责，指标只负责聚合。

### 日志字段级脱敏

`@tps/shared` 的 logger 在序列化层剥离凭据、`email`、`created_ip`、`raw_request`、`plan_json` 等字段，不依赖调用方自觉。`created_ip` 只允许进 `createAuditLogger()` 这一条通道。

### 优雅停机不是可选项

Worker 收到 `SIGTERM` 若直接退出，在途任务会把 `generation_jobs` 留在中间态上悬挂 —— 既不是终态也不会被重新消费。K8s 滚动更新每次都触发 `SIGTERM`，这是常规路径而非异常路径。

`GracefulShutdown` 按注册的**逆序**执行钩子（组件先停、基础设施后停），单个钩子失败不阻断其余钩子，超时强制退出。容器以 tini 作为 PID 1 回收僵尸子进程（Chromium 会产生）。

### 跨平台护栏

开发在 Windows、运行在 Linux，四类故障会**静默**发生：

| 护栏           | 拦住什么                                                                      | 由谁强制                                                            |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 文件名大小写   | `import './TravelCard'` 引用 `travelCard.tsx` —— Windows 能跑，Linux 构建失败 | `forceConsistentCasingInFileNames` + Linux CI 上的 `tsc`            |
| 路径分隔符     | 硬编码 `\` —— Linux 上被当作文件名的一部分，不报错只是找错文件                | 本地 ESLint 规则 `tps-local/no-windows-path-separator`              |
| 换行符         | CRLF 混入 shell 脚本导致 `bad interpreter`，混入视觉基线导致误报              | `.gitattributes` + Prettier `endOfLine: lf`                         |
| 平台原生二进制 | `sharp` 的 win32 二进制被拷进 Linux 镜像                                      | `pnpm.supportedArchitectures` + `.dockerignore` 排除 `node_modules` |

**这四项护栏自身也被测试**：`pnpm verify:linux-guardrails` 主动制造违规，确认工具真的会失败。一个只会被工具拦住、而工具又配错了的护栏，等于完全没有护栏 —— 而且是静默失效。

## CI

| Job          | 内容                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `verify`     | format / lint / typecheck / test / build（L-01、L-02）                        |
| `guardrails` | 护栏反向测试                                                                  |
| `migrations` | 迁移在 `pgvector/pgvector:pg17` 上执行 + 幂等性复跑 + 三扩展确认（L-09）      |
| `images`     | 五个镜像在 `linux/amd64` 构建 + 非 root UID / TZ / LANG / tzdata 校验（L-03） |

L-04～L-08、L-10 依赖 P1 才引入的 Playwright、字体与 sharp，在对应任务落地时加入。
