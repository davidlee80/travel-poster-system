# 通用 Node 服务镜像（api / generation-worker / retention-worker）
#
# 设计稿 22.3.1 的容器基线：
#   - Debian bookworm slim（glibc），不用 Alpine —— musl 上 sharp 需自建、
#     tzdata/fontconfig 缺省缺失、Chromium 问题多
#   - 数值型非 root UID/GID 10001（名字在某些 K8s runAsUser 校验下不生效）
#   - tzdata 安装 + TZ=UTC（应用按请求 timezone 转换）
#   - LANG=C.UTF-8（不依赖宿主 locale）
#   - tini 作为 PID 1（回收僵尸子进程）
#
# 构建（从仓库根）：
#   docker build --platform=linux/amd64 \
#     -f deploy/images/node-service.Dockerfile \
#     --build-arg APP=api --build-arg PROBE_PORT=3001 -t tps/api .

# ── 依赖安装层 ────────────────────────────────────────────
# ── 清单提取层 ────────────────────────────────────────────
#
# pnpm 的 --frozen-lockfile 要求**全部** workspace 包的 package.json 都在场。
# 手写一份清单列表必然过时：新增一个包时没人会想到来改三个 Dockerfile，
# 而报出的错误是 ERR_PNPM_OUTDATED_LOCKFILE —— 与「少拷了一个文件」毫无关联。
#
# 因此机械提取。本层每次都会重建（COPY . . 对任何改动失效），但它的产物
# 只在 package.json 变化时才变，所以下游的 install 层照旧命中缓存。
FROM node:24-bookworm-slim AS manifests
WORKDIR /repo
COPY . .
RUN mkdir -p /manifests \
 && find . -name package.json \
      -not -path '*/node_modules/*' -not -path '*/.next/*' \
      -exec cp --parents {} /manifests/ ';'

FROM node:24-bookworm-slim AS deps
ARG APP

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable

WORKDIR /repo

# 只拷贝清单文件，让依赖层能在源码变动时命中缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# 全部 workspace 包的 package.json（含根 package.json），目录结构与仓库一致
COPY --from=manifests /manifests/ ./

# --frozen-lockfile：锁文件与清单不一致时失败，而不是悄悄改锁文件
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── 构建层 ────────────────────────────────────────────────
FROM deps AS build
ARG APP

COPY tsconfig.base.json turbo.json ./
COPY tools/ tools/
COPY packages/ packages/
COPY apps/ apps/
COPY infrastructure/migrations infrastructure/migrations

RUN pnpm --filter "@tps/${APP}..." run build

# 剪出仅含运行时依赖的 node_modules
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    # deploy 只接受**单个**项目。用 "@tps/x..."（含依赖）会展开成多个包，
    # 报 ERR_PNPM_CANNOT_DEPLOY_MANY。workspace 依赖由 deploy 自行解析并注入 /out，
    # 所以不需要（也不能）在这里列出它们。
    pnpm --filter "@tps/${APP}" deploy --legacy --prod /out

# ── 运行层 ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
ARG APP
ARG PROBE_PORT=3001

ENV NODE_ENV=production \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORT=${PROBE_PORT} \
    NODE_OPTIONS=--enable-source-maps

# tzdata：Asia/Shanghai 等时区转换需要它，slim 镜像默认不含
# tini：Node 不回收僵尸子进程，PID 1 必须是 init
# DEBIAN_FRONTEND=noninteractive 不能省：tzdata 的 postinst 会交互式询问时区，
# 而构建没有 tty —— 表现是**构建永久挂住**而不是报错。
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 数值型 UID/GID
RUN groupadd --gid 10001 tps \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin tps

WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./
# 数据库迁移任务通过 MIGRATIONS_DIR=/app/migrations 使用；应用镜像也带同一份
# 不可变迁移，避免“代码已经升级、数据库仍停在旧版本”的静默漂移。
COPY --from=build --chown=10001:10001 /repo/infrastructure/migrations ./migrations

USER 10001:10001
EXPOSE ${PROBE_PORT}

# tini 转发 SIGTERM 给 node，优雅停机框架据此排空（设计稿 22.3.3、L-10）
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/main.js"]
