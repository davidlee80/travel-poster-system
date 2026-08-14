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
FROM node:24-bookworm-slim AS deps
ARG APP

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable

WORKDIR /repo

# 只拷贝清单文件，让依赖层能在源码变动时命中缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/schemas/package.json      packages/schemas/
COPY packages/shared/package.json       packages/shared/
COPY packages/observability/package.json packages/observability/
COPY packages/db/package.json           packages/db/
COPY apps/api/package.json              apps/api/
COPY apps/generation-worker/package.json apps/generation-worker/
COPY apps/render-worker/package.json    apps/render-worker/
COPY apps/retention-worker/package.json apps/retention-worker/
COPY apps/web/package.json              apps/web/

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

RUN pnpm --filter "@tps/${APP}..." run build

# 剪出仅含运行时依赖的 node_modules
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter "@tps/${APP}..." deploy --legacy --prod /out

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 数值型 UID/GID
RUN groupadd --gid 10001 tps \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin tps

WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./

USER 10001:10001
EXPOSE ${PROBE_PORT}

# tini 转发 SIGTERM 给 node，优雅停机框架据此排空（设计稿 22.3.3、L-10）
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/main.js"]
