#!/usr/bin/env node
/**
 * 生成本机整栈 e2e 用的 `.env.deploy`。
 *
 *   node tools/gen-local-env.mjs            # 已存在则拒绝覆盖
 *   node tools/gen-local-env.mjs --force    # 覆盖（旧文件另存为 .env.deploy.bak）
 *   node tools/gen-local-env.mjs --print    # 只打印到标准输出，不落盘（密钥仍是新的）
 *
 * ## 存在的理由
 *
 * `deploy/mvp-apps.yml` 的每个服务都 `env_file: ../.env.deploy`，因此不生成
 * 这个文件连 `docker compose build` 都起不来。而它有两项**必须逐台生成**的
 * 密钥（RENDER_SIGNING_KEY / INTERNAL_API_KEY），手抄 `deploy/mvp.env.example`
 * 时最容易漏的恰恰是这两项 —— 漏了的表现不是启动失败，而是：
 *
 *   RENDER_SIGNING_KEY 两边不一致  →  导出永远停在 RENDERING（渲染页一律 404）
 *   INTERNAL_API_KEY 留空          →  api 不注册内部路由，渲染页拿不到数据
 *
 * 两种都是「服务全部健康、功能静默失效」，所以让机器生成而不是让人抄。
 *
 * ## 这份产物是给本机的，不是给云主机的
 *
 * 与 `deploy/mvp.env.example`（云上那份）有三处刻意的差异，逐条标在输出里。
 * 云上部署仍然照 docs/云服务器部署说明.md 走，不要把这份文件传上去。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repoRoot, '.env.deploy');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const printOnly = argv.includes('--print');

const key = () => randomBytes(32).toString('hex');

const content = `# 本机整栈 e2e 的环境变量（由 tools/gen-local-env.mjs 生成）
#
# **这份是本机用的，不是云主机用的。** 云上照 docs/云服务器部署说明.md 走，
# 与 deploy/mvp.env.example 的三处差异标在下面各自的位置。
#
# 启动：
#   docker compose -f infrastructure/docker-compose.yml -f deploy/mvp-apps.yml up -d --build
#
# 停止（保留数据库卷）：
#   docker compose -f infrastructure/docker-compose.yml -f deploy/mvp-apps.yml down

NODE_ENV=production
LOG_LEVEL=info
TZ=UTC

# ── 数据库与 Redis ────────────────────────────────────────────
#
# 主机名是 compose 服务名，口令沿用 infrastructure/docker-compose.yml 里的开发口令。
DATABASE_URL=postgres://tps:tps_local_dev_only@postgres:5432/travel_poster
REDIS_URL=redis://redis:6379

# ── 对象存储 ──────────────────────────────────────────────────
#
# 【与云上差异 1／3】S3_ENDPOINT 与 S3_PUBLIC_BASE_URL 用 localhost:9000，
# 云上是 https://travel.doomet.cn。
#
# 这个变量要求「浏览器能访问到」—— 13.6 的导出下载是 api 算出的 SigV4 预签名
# URL，主机名就取自它。本机浏览器经宿主端口映射访问 minio，所以是 localhost:9000。
#
# 注意一个本机特有的不对称：这个地址在 **api 容器内部** 指向容器自己而不是
# minio。设计上 api 只用它拼签名、不发起 S3 请求（三个 worker 各自覆盖成
# http://minio:9000，见 mvp-apps.yml），所以不影响。若 api 启动时报 S3 连接
# 失败，说明这个假设不成立 —— 那是一个真实的发现，不要改这一行来绕过它。
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=tps
S3_SECRET_ACCESS_KEY=tps_local_dev_only
S3_BUCKET_ASSETS=tps-assets
S3_BUCKET_EXPORTS=tps-exports
S3_FORCE_PATH_STYLE=true

# 会被写进 plan_presentations.view_model 并**永久保存**（19.3）。
# 本机库里因此会留下 localhost 地址的记录 —— 开发库无妨，但别拿这个库当参考数据。
S3_PUBLIC_BASE_URL=http://localhost:9000/tps-assets

# ── 密钥（本次生成，每跑一次都不同）──────────────────────────
#
# RENDER_SIGNING_KEY：17.1 内部渲染路由的 HMAC。render-worker 签发、web 校验，
#   **两个服务必须同值** —— 两者都从这一个文件读，所以天然一致。
# INTERNAL_API_KEY：14.1/14.2 内部端点的共享密钥。不能加 NEXT_PUBLIC_ 前缀，
#   否则会被打进浏览器包。
RENDER_SIGNING_KEY=${key()}
INTERNAL_API_KEY=${key()}

# ── HTTPS 与 Cookie ──────────────────────────────────────────
#
# 【与云上差异 2／3】本机是 http，必须显式关掉 secure，否则浏览器静默丢弃
# 会话 Cookie —— 表现是「注册成功但立刻又是未登录」。云上配好 TLS 后删掉这行。
COOKIE_SECURE=false

# 本机验证码不调用短信供应商；接口回传 dev_code，前端自动填入。
SMS_MODE=local
SMS_VERIFICATION_PEPPER=${key()}

# ── 模型与图源 ────────────────────────────────────────────────
#
# 【与云上差异 3／3】保持 fake：本轮先验证编排本身，模型凭据另一条线走
# （见 tools/probe-llm.mjs 与 tools/probe-image.mjs）。
#
# fake 跑得通整条链路，但产出的是固定的杭州 POI + 渐变占位图。
LLM_MODE=fake
LLM_MODEL=
LLM_BASE_URL=
LLM_API_KEY=

IMAGE_MODE=fake
IMAGE_MODEL=
IMAGE_BASE_URL=
IMAGE_API_KEY=

IMAGE_SEARCH_MODE=fake

# ── 灰度开关 ──────────────────────────────────────────────────
FEATURE_GENERATION_ENABLED=true
FEATURE_EXPORT_ENABLED=true
FEATURE_GENERATION_ROLLOUT_PERCENT=100
FEATURE_ANONYMOUS_ENABLED=false

# ── 用户货币 CR ───────────────────────────────────────────────
#
# 三侧一起开（api / generation-worker / render-worker）：只开一侧各有各的坏处，
# 见 docs/用户货币与计费.md 的「三侧开关必须一起开」。
#
# 打开它**不会立刻开始收费** —— 迁移 0013 种下的价目表是占位版（版本 1），
# 实现把它视为「还没配价」。运营 clone 到版本 2 并发布后自动生效，
# 最多 60 秒。因此这里默认 true 是安全的：结构就位，钱不动。
#
# 前提是库已迁到 0013（pnpm db:migrate）。没迁就打开的话，
# 每个生成请求与每次会话查询都会撞一张不存在的表。
CREDIT_BILLING_ENABLED=true

# ── 可观测性（留空 = 不装配 OTel SDK）────────────────────────
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_SERVICE_NAME=travel-poster-system

# 必须小于 compose 的 stop_grace_period（45s，见 mvp-apps.yml）
SHUTDOWN_TIMEOUT_MS=25000
`;

if (printOnly) {
  process.stdout.write(content);
  process.exit(0);
}

if (existsSync(target) && !force) {
  process.stderr.write(
    `${target} 已存在，未做改动。\n` +
      `要重新生成加 --force（旧文件会另存为 .env.deploy.bak）。\n` +
      `注意：重新生成会换掉两个密钥，已在 RENDERING 中的导出任务会因此失效。\n`,
  );
  process.exit(1);
}

if (existsSync(target)) {
  writeFileSync(`${target}.bak`, readFileSync(target));
  process.stdout.write(`旧文件已备份到 .env.deploy.bak\n`);
}

writeFileSync(target, content, 'utf8');

process.stdout.write(
  `已写入 ${target}\n` +
    `  RENDER_SIGNING_KEY / INTERNAL_API_KEY：各 32 字节随机值（不在此回显）\n` +
    `  LLM_MODE / IMAGE_MODE：fake\n` +
    `  COOKIE_SECURE：false（本机 http）\n` +
    `  S3 对外地址：http://localhost:9000\n\n` +
    `.env.deploy 不入库（仓库根 .gitignore 的 .env* 规则）。\n`,
);
