# 旅行计划信息图系统

自动生成旅行计划的可浏览 HTML、每日信息图、PNG 长图与 PDF。全链路无需人工介入。

```text
用户提交旅行诉求 → 后端标准化 → 大模型生成结构化计划 → 程序校验并自动修复
→ 展示编排 → 素材服务（图片/图标/地图）→ ViewModel → React 模板渲染 HTML
→ Playwright 导出 PNG/PDF → 展示给用户
```

**工程真相源**：[docs/旅行计划信息图系统 V1 详细设计.md](docs/旅行计划信息图系统%20V1%20详细设计.md)（V1.7）
**实施计划与进度**：[docs/旅行计划信息图系统 V1 实施计划.md](docs/旅行计划信息图系统%20V1%20实施计划.md)
**工程 Wiki**：[docs/wiki/README.md](docs/wiki/README.md)（架构、主链路、功能到代码映射、数据与运维导航）
**云服务器部署**：[docs/云服务器部署说明.md](docs/云服务器部署说明.md)（Ubuntu 单机内测；正式上线走 `deploy/helm/`）

当前阶段：**P0～P9 已完成**，并已加入多模型故障转移、手机认证、规划器配置中心与可开关的 CR 钱包计费。真实供应商联调、真实素材与人工 SLA/命中率门禁见 [Wiki 的实施状态与已知边界](docs/wiki/07-实施状态与已知边界.md)。

## 环境要求

| 工具   | 版本         | 说明                                        |
| ------ | ------------ | ------------------------------------------- |
| Node   | 24 LTS       | `engines` 已声明并启用 `engine-strict`      |
| pnpm   | ≥ 10         | `corepack enable`，或 `npm i -g pnpm@10`    |
| Docker | 任意近期版本 | 本地 PostgreSQL / Redis / MinIO             |
| Python | ≥ 3.9        | 仅城市导入脚本及其测试需要，另需 `pypinyin` |

Docker 需支持 `docker compose`，Windows 上使用 Linux 容器模式。pnpm 的仓库固定版本见
`package.json` 的 `packageManager`，安装依赖时优先使用该版本。

**运行平台是 Linux。** 开发可以在 Windows / macOS，但只有 Linux CI 全绿才算通过 —— 详见设计稿 22.3 与下方「跨平台护栏」。

## 快速开始

以下命令均从仓库根目录执行。通用命令兼容 Bash 与 PowerShell；有环境变量赋值时分别提供示例。
按顺序执行，前一步成功后再执行下一步（Windows PowerShell 5.1 不支持 `&&`）。

### 基础代码检查

在未设置数据库、Redis 连接变量的独立终端中执行：

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

预期各命令退出码为 0。`pnpm test` 执行各包默认 Vitest 测试，部分集成用例被排除或因缺少
`DATABASE_URL` / `REDIS_URL` 而跳过；它不代表数据库、队列、浏览器和导出链路全部通过。
需要真实依赖的测试见下方「本地自动化测试」。

### 宿主机数据库迁移（按需）

只运行上述代码检查无需启动整栈。需要从宿主机调试数据库时，首次创建 `.env`；已有文件保留：

```powershell
# Windows PowerShell
if (!(Test-Path .env)) { Copy-Item env.example .env }
```

```bash
# Bash
if [ ! -f .env ]; then cp env.example .env; fi
```

确认 `.env` 中 `DATABASE_URL` 指向预期的本地开发库，再执行：

```bash
pnpm infra:up
docker compose -f infrastructure/docker-compose.yml ps -a
# 等 postgres / redis / minio 显示 healthy，minio-init 显示 Exited (0)
pnpm db:build
node --env-file=.env packages/db/dist/cli.js migrate
node --env-file=.env packages/db/dist/cli.js status
```

预期迁移状态为「待应用: 0」，且没有校验和漂移。复制 `.env` 不会把变量加载进终端；这里通过
Node 的 `--env-file` 显式读取。若终端已设置同名变量，它们优先于文件，需先清除或换用干净终端。
`pnpm db:migrate` / `pnpm db:status` 本身不加载 `.env`，只适用于已注入环境变量的终端或 CI。

`.env` 用于宿主机命令（数据库、Redis 地址为 `localhost`）；`.env.deploy` 用于整栈容器
（地址为 `postgres`、`redis` 等服务名）。不要互相替代。整栈启动会自动执行迁移，无需先运行本节。
基础设施日志用 `pnpm infra:logs` 查看，停止用 `pnpm infra:down`（保留数据卷）。

### 用浏览器点这个应用

Windows 上需要每次清理构建缓存、重建服务并打开全新的浏览器测试窗口时，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-local-test.ps1
```

[start-local-test.ps1](tools/start-local-test.ps1) 会清理仓库内的 `.turbo` 与前端 `.next`，
通过 Docker `--no-cache` 逐个重建五个应用镜像，成功后停止旧应用、重新创建整栈容器，
等待健康检查通过，再打开 `http://localhost:8080`。构建失败时不会停止旧容器。
健康等待只针对长驻服务；迁移和 MinIO 初始化容器另行检查退出码，`Exited (0)` 视为成功。
脚本通过自身位置定位仓库，也可在其他目录使用绝对路径调用。需 Node、Docker Desktop（Linux 容器）；
不依赖宿主机 pnpm，首次缺少 `.env.deploy` 时自动生成，已有配置保留。

同一仓库同时只允许一份启动脚本运行。若 Docker 报 `failed to read metadata` 且文件
`being used by another process`，脚本会等待后重试当前镜像，最多尝试 3 次；普通编译错误不重试。
文件锁持续存在时，先结束其他 Docker 构建并用 `docker buildx ls` 检查构建器，再重跑脚本。
必要时在其他 Docker 工作结束后重启 Docker Desktop，不要删除 `.docker/contexts` 元数据。

缓存清理范围是本地构建缓存和重新创建容器后的进程内缓存；Docker 镜像层缓存被绕过，
依赖下载缓存仍可复用，不执行全局 Docker prune。PostgreSQL、Redis 队列及会话、MinIO 文件均保留，
数据库中的历史行程和素材也保留。脚本会短暂中断当前本地整栈，正在进行的浏览器测试应先结束。

脚本为 Edge / Chrome 创建独立的测试配置目录，避免沿用旧 HTTP 缓存、Cookie 和 localStorage，
测试窗口需重新登录。目录位于 `tmp/local-test-browser/<随机编号>/`，关闭对应浏览器后可手动删除；
它们不入库也不进入 Docker 构建上下文。没有 Edge / Chrome 时会提示手动打开干净的浏览器配置。

```powershell
# 仅显示步骤，不删除缓存、不启动容器、不打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-local-test.ps1 -DryRun
# 重建并启动服务，但不打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-local-test.ps1 -NoBrowser
```

脚本的流程回归测试可在 Windows 上运行 `node --test tools/start-local-test.test.mjs`；
测试用模拟 Docker / HTTP 验证失败处理和缓存清理边界，不会重启实际服务。

以下为手动启动方式，适合复用现有镜像和浏览器会话：

要在浏览器里走一遍「登录 → 填表 → 生成 → 看计划 → 导出」，
需要五个应用容器**加一层反代**：

```bash
node tools/gen-local-env.mjs      # 仅首次：生成 .env.deploy 和本地密钥；已有文件则跳过此命令
pnpm mvp:build
pnpm mvp:up
# 然后开 http://localhost:8080
```

生成器在文件已存在时拒绝覆盖；日常启动复用现有配置。`--force` 会备份旧文件并重新生成密钥，
仅在有意重置配置时使用。

默认配置下，`SMS_MODE=local` 不发送真实短信，接口返回开发验证码，前端自动填入；
`FEATURE_ANONYMOUS_ENABLED=false`，需先注册或登录。`LLM_MODE=fake`、`IMAGE_MODE=fake`
及 `IMAGE_SEARCH_MODE=fake` 使用模拟数据，用于验证流程，不要求真实供应商凭据；
示例行程和渐变图片属于预期结果。真实供应商联调需另行配置，见
[实施状态与已知边界](docs/wiki/07-实施状态与已知边界.md)。

启动返回后，先检查服务是否就绪：

```bash
docker compose -f infrastructure/docker-compose.yml -f deploy/mvp-apps.yml -f deploy/local-proxy.yml --env-file .env.deploy ps -a
node -e "fetch('http://localhost:3001/readyz').then(r=>{console.log(r.status);process.exit(r.status===200?0:1)}).catch(()=>process.exit(1))"
```

长驻服务应为运行且健康；`tps-db-migrate` 与 `tps-minio-init` 是一次性任务，`Exited (0)` 表示成功。
API 就绪检查应输出 `200`。失败时运行 `pnpm mvp:logs`，或用 `docker logs tps-db-migrate`
查看迁移错误；日志跟随模式按 Ctrl+C 退出，不会停止服务。

**是 8080，不是 3000。** `NEXT_PUBLIC_API_BASE` 在 web 镜像里固化为空串，
浏览器发的是同源 `/api/v1/...`；生产上由 Nginx 转给 api，本地由
`deploy/local-proxy.yml` 里的 nginx 承担。直接开 3000 端口时每个 API 请求都
404，页面右上角报「网络连接失败」，一步也走不下去。

浏览器验证清单：

1. 打开 `http://localhost:8080`，完成注册或登录。默认配置下，未登录时
   `/api/v1/auth/session` 返回 `401` 是预期行为。
2. 填写一份有效行程并提交，确认生成进度最终完成，没有一直停留在等待状态。
3. 查看完整计划和单日信息图，确认中文、布局和图片可显示。
4. 分别导出 PNG、PDF，确认下载成功且文件能打开、内容完整。

应用容器使用构建产物；修改代码后重新执行 `pnpm mvp:build`，成功后执行 `pnpm mvp:up`
以更新容器。`pnpm mvp:down` 停栈并保留数据卷。

### 生成可离线打开的页面快照

把当前前端存成一组 HTML 发给别人，或者在不跑 Docker 的机器上翻一遍页面。

```bash
node tools/gen-local-env.mjs      # 仅首次：已有 .env.deploy 则跳过此命令
pnpm mvp:build
pnpm mvp:up                      # 整栈必须跑着 —— 它要现场生成一份计划
pnpm preview
# 产物在 preview/，双击任一 .html，不需要跑任何服务
```

四个页面：`planner.html`（采集工作台）、`legal.html`（用户协议与隐私政策）、
`full.html`（完整计划信息图）、`day1.html`（单日信息图）。

选项用 `pnpm preview -- --help` 列全（注意那个裸 `--`，pnpm 要靠它把参数传下去）。
最常用的是 `--plan-version <uuid>`：复用已有的计划版本、跳过生成，快一分多钟；
改了前端反复重生快照时用它。

`preview/` **不入库** —— 它是「当前代码 + 一份现场生成的计划」的函数，随时可重生，
而其中 `fonts.css` 有 10 MB（字体内联成 data URI）。

#### 三件事先知道比事后查快

**不能替代 8080。** 快照里看不到任何需要后端的状态 —— 注册与登录表单、改密码、
生成等待弹层、计划页。要试那些只能开浏览器点真的（见上一节）。`planner.html`
打开时右上角有一条红色「网络连接失败」，那是离线的预期表现而不是缺陷。

**整栈没起时它会直接告诉你怎么办。** 探活打 `/api/v1/auth/session` 并要求
拿到 401：连不上说明栈没跑，拿到 404 说明用的是 3000 而不是 8080（那个端口上
没有 `/api` 反代），拿到 200 说明 `FEATURE_ANONYMOUS_ENABLED` 被打开了。

**`/legal` 的内容在构建期**从 [docs/用户协议与隐私政策.md](docs/用户协议与隐私政策.md)
读入，因此改完那份文档要 `pnpm mvp:build` 重建 web —— 光重启容器、或者只重跑
`pnpm preview`，那一页还是旧的。

流程本身（现场生成计划 → 在容器里签渲染令牌取内部页面 → 字体内联成 data URI →
资源改相对路径）与每一步的理由写在 [tools/build-preview.mjs](tools/build-preview.mjs)
的头注释里。`/render/**` 那两页必须在容器里取：它们对公网 404，且受 HMAC 保护，
而签名密钥不出容器。

## 本地自动化测试

### 数据库、队列与链路测试

**这些测试会执行 `DELETE FROM users`、Redis `FLUSHDB` 等清理操作。** 使用专门的测试容器，
不要连接浏览器调试库或生产环境，也不要让应用 Worker 连接测试实例。以下示例通过独立容器和
端口与日常整栈隔离；不需要启动 API、web 或 MinIO，测试自行组装所需组件。

首次创建测试依赖（示例口令仅用于本机测试）：

```bash
docker run -d --name tps-test-postgres -p 127.0.0.1:15432:5432 -e POSTGRES_USER=tps -e POSTGRES_PASSWORD=tps_test_only -e POSTGRES_DB=travel_poster_test pgvector/pgvector:pg17
docker run -d --name tps-test-redis -p 127.0.0.1:16379:6379 redis:7-bookworm
```

后续复用已有容器用 `docker start tps-test-postgres tps-test-redis`，不要重复 `docker run`。
检查依赖，未就绪则等待后重试，必要时查看对应容器的 `docker logs`：

```bash
docker exec tps-test-postgres pg_isready -U tps -d travel_poster_test
docker exec tps-test-redis redis-cli ping
```

预期分别输出 `accepting connections` 和 `PONG`。在专用于测试的新终端中设置连接变量：

```powershell
# Windows PowerShell
$env:DATABASE_URL = 'postgres://tps:tps_test_only@localhost:15432/travel_poster_test'
$env:REDIS_URL = 'redis://localhost:16379'
```

```bash
# Bash
export DATABASE_URL='postgres://tps:tps_test_only@localhost:15432/travel_poster_test'
export REDIS_URL='redis://localhost:16379'
```

在同一终端逐条执行，每条成功后再继续：

```bash
pnpm db:migrate
pnpm db:status
pnpm test:integration
pnpm test:e2e
pnpm test:acceptance
```

| 命令                    | 验证范围                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm test:integration` | 各包的真实数据库、Redis 集成测试；根脚本已限制包间并发                    |
| `pnpm test:e2e`         | 提交、入队、生成、编排与计划读取链路；不包含浏览器点击和真实 PNG/PDF 导出 |
| `pnpm test:acceptance`  | 多种行程天数、约束和身份组合的链路验收                                    |

预期迁移无待应用项，测试退出码为 0，且数据库、Redis 用例实际执行。
检查测试报告中的 skipped 项：缺失连接变量引起的跳过不能算通过；Windows 上 SIGTERM 停机测试
按设计跳过，需要 Linux 验证。几类测试覆盖有重叠，可按改动选择运行，但不要同时运行多个测试命令
或多个终端中的测试，以免清理彼此的夹具。

测试后关闭专用终端，避免连接变量影响后续调试，并停止依赖：

```bash
docker stop tps-test-postgres tps-test-redis
```

需要彻底重建测试数据时，在停止后执行 `docker rm -v tps-test-postgres tps-test-redis`，
只删除上述专用测试容器及其匿名卷，再按首次创建步骤重建。不要对日常整栈执行带 `-v` 的清理命令。

### 渲染与视觉回归

先安装 Node 依赖并启动 Docker 的 Linux 容器引擎，在未设置 `FIXTURE_*` 覆盖变量的终端执行：

```bash
pnpm fixture:render
pnpm visual:check
```

默认在 Linux 容器中生成 `ink_paper_v1` 套件的 14 天 HTML、PNG、PDF，写入 `out-fixtures/`；
随后在宿主机比对该组合的第 1 天 PNG 和布局摘要。预期输出「视觉回归通过」，并人工打开产物检查中文与排版。
失败差异图在 `apps/render-worker/__visual__/actual/`。本流程不依赖数据库和浏览器整栈。

`visual:check` 每次只检查 `out-fixtures/render-meta.json` 指定的当前组合，不会自动遍历所有基线。
完整回归需覆盖 1 / 7 / 14 天与各套件的组合（当前为 `ink_paper_v1`、`blueprint_v1`，定义见
`packages/schemas/src/enums.ts`）。例如检查 7 天蓝图套件：

```powershell
# Windows PowerShell：设置后，依次运行上面的 fixture:render、visual:check
$env:FIXTURE_DAYS = '7'
$env:FIXTURE_TEMPLATE = 'blueprint_v1'
$env:FIXTURE_FORMAT = 'all'
```

```bash
# Bash：设置后，依次运行上面的 fixture:render、visual:check
export FIXTURE_DAYS=7
export FIXTURE_TEMPLATE=blueprint_v1
export FIXTURE_FORMAT=all
```

每个组合必须先渲染成功再比对，然后切换下一组；完成后关闭该终端以清除覆盖变量。
低共享内存专项检查用 `pnpm fixture:render:low-shm`；渲染测试完成后用 `pnpm fixture:down`
清理独立 fixture 栈。基线须来自 Linux 容器，确认视觉变化符合预期后才更新；修改基线的 PR
还需 `visual-baseline-approved` 标签，详见 CI 工作流。

### 城市导入脚本测试

此测试独立于 `pnpm test`，也未加入当前 CI 工作流。在装有 Python 的终端执行
（若本机命令是 `python3`，将下方 `python` 替换为 `python3`）：

```bash
python -m pip install pypinyin
python -m unittest discover -s tools -p test_extract_cities_from_md.py
```

预期 unittest 输出 `OK`。用例在临时目录中验证 Markdown 过滤、名称补全、跨洲索引、增量合并和
备份恢复等行为，联网请求使用模拟响应或模拟断网，不依赖真实搜索服务，也不会修改正式城市数据。
实际导入用法见 [脚本头部说明](tools/extract-cities-from-md.py)。

更多专项测试、验收门禁和运维说明见 [测试、部署与运维 Wiki](docs/wiki/06-测试部署与运维.md)。

## 常用命令

| 命令                                          | 作用                                      |
| --------------------------------------------- | ----------------------------------------- |
| `pnpm build`                                  | 全量构建                                  |
| `pnpm typecheck`                              | 类型检查（含测试文件）                    |
| `pnpm lint`                                   | ESLint                                    |
| `pnpm test`                                   | 各包默认 Vitest 测试；不等于完整链路验收  |
| `pnpm test:integration`                       | 数据库 / Redis 集成测试，需隔离的测试实例 |
| `pnpm test:e2e` / `test:acceptance`           | 服务链路与场景验收，需测试数据库和 Redis  |
| `pnpm fixture:render` / `visual:check`        | Linux 容器渲染 / 当前产物视觉比对         |
| `pnpm format` / `format:check`                | Prettier                                  |
| `pnpm verify:linux-guardrails`                | 跨平台护栏反向测试                        |
| `pnpm infra:up` / `infra:down` / `infra:logs` | 本地基础设施                              |
| `pnpm mvp:up` / `mvp:down` / `mvp:build`      | 整栈 + 反代（见上）                       |
| `pnpm mvp:logs`                               | 跟随整栈日志，Ctrl+C 退出                 |
| `pnpm preview`                                | 离线 HTML 页面快照                        |
| `pnpm db:migrate` / `db:status`               | 数据库迁移，需先注入环境变量              |

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

规划器的标签、预算档位、选择框和复选项采用数据库发布版本管理，增删、排序与改文案见 [规划器配置中心](docs/规划器配置中心.md)。

计费价目表用同一套版本化发布机制（`credit_price_*`）。用户货币 CR 把大模型 token 与后端生成服务的消耗合成一个数，设计与分期见 [用户货币与计费](docs/用户货币与计费.md)。**当前价目是占位值，上线前需按真实供应商成本重定。**

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

| Job               | 内容                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `verify`          | format / lint / typecheck / test / build（L-01、L-02）                                       |
| `guardrails`      | 护栏反向测试                                                                                 |
| `migrations`      | 迁移在 `pgvector/pgvector:pg17` 上执行 + 幂等性复跑 + 三扩展确认（L-09）                     |
| `helm`            | Helm lint、模板渲染与 Kubernetes 资源校验                                                    |
| `visual-baseline` | PR 修改视觉基线时检查 `visual-baseline-approved` 标签                                        |
| `shutdown`        | Linux 上真实 Worker 收到 SIGTERM 后退出且任务无悬挂（L-10）                                  |
| `images`          | 五个镜像在 `linux/amd64` 构建 + 非 root UID / TZ / LANG / tzdata 校验（L-03）                |
| `render`          | Linux 容器字体 / sharp 检查、14 天渲染、视觉比对、低共享内存与基线来源反向测试（L-04～L-08） |

以上任务已配置，实际执行范围以 [.github/workflows/ci.yml](.github/workflows/ci.yml) 为准。
CI 的默认 `render` 任务检查 14 天默认套件，不代表所有天数与套件组合均已检查；
`test:integration`、`test:e2e`、`test:acceptance` 和 Python 脚本测试也不能由默认 `verify` 的结果替代。
本地可执行基础检查、隔离实例上的集成测试及 Docker 渲染；SIGTERM 停机、Linux standalone
产物与镜像约束需在 Linux 环境验证。CI 全绿仍需结合所改功能的专项测试与浏览器验证。
