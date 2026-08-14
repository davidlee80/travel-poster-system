# 渲染 Worker 镜像（Playwright + Chromium + 中文字体）
#
# 与通用 Node 服务镜像分开的原因（设计稿 22.2）：本镜像约 1.2GB，
# 合并会让所有 Worker 都背上这个体积。
#
# 关键约束（设计稿 22.3.1、22.3.2）：
#   - 基于官方 Playwright 镜像（Ubuntu jammy，glibc），自建容易漏系统库
#   - 中文字体必须**系统级安装**并 fc-cache，不能只靠 @font-face ——
#     否则 SVG <text>、<input>、字体回退路径拿不到中文字形（17.5）
#   - 非 root 运行；Playwright 镜像自带 pwuser，但我们统一用数值 UID 10001
#   - 部署时必须给 /dev/shm 至少 1Gi，否则 Chromium 崩溃（L-07）
#
# 构建（从仓库根）：
#   docker build --platform=linux/amd64 -f deploy/images/render-worker.Dockerfile -t tps/render-worker .

# Playwright 版本必须与 package.json 中的 playwright 版本一致，
# 否则镜像内的浏览器与库不匹配。P1（TP-1-10）接入 Playwright 时同步此处。
ARG PLAYWRIGHT_VERSION=1.56.0

# ── 依赖与构建层（复用通用 Node 基底，构建不需要 Chromium）────
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable

WORKDIR /repo

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

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json turbo.json ./
COPY tools/ tools/
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm --filter "@tps/render-worker..." run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter "@tps/render-worker..." deploy --legacy --prod /out

# ── 运行层 ────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS runtime

ENV NODE_ENV=production \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORT=3012 \
    NODE_OPTIONS=--enable-source-maps \
    # 与基线截图一致的字体渲染（设计稿 22.3.2）
    CHROMIUM_FONT_RENDER_HINTING=none

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata tini fontconfig \
 && rm -rf /var/lib/apt/lists/*

# 中文字体：P1（TP-1-04）产出子集化文件到 packages/fonts/dist。
# 先建目录，字体文件在 P1 随构建产物拷入并执行 fc-cache。
RUN mkdir -p /usr/share/fonts/truetype/noto-sc

# TODO(P1/TP-1-04)：取消注释并拷入子集化字体，然后 fc-cache
# COPY --from=build /repo/packages/fonts/dist/*.ttf /usr/share/fonts/truetype/noto-sc/
# RUN fc-cache -f -v \
#  && test "$(fc-list | grep -ci noto)" -ge 1 || (echo 'L-04 失败：镜像内无 Noto 字体' && exit 1)

RUN groupadd --gid 10001 tps \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin tps

WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./

USER 10001:10001
EXPOSE 3012

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/main.js"]
