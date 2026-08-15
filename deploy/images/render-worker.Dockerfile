# 渲染 Worker 镜像（Playwright + Chromium + 中文字体）
#
# 与通用 Node 服务镜像分开的原因（设计稿 22.2）：本镜像约 1.2GB，
# 合并会让所有 Worker 都背上这个体积。
#
# 关键约束（设计稿 22.3.1、22.3.2）：
#   - 基于官方 Playwright 镜像（Ubuntu jammy，glibc），自建容易漏系统库
#   - 系统级安装**完整** Noto CJK（apt fonts-noto-cjk）并 fc-cache（R-15）：
#     一是 SVG <text>、<input>、字体回退路径需要系统字形，二是给子集
#     未覆盖的生僻字兜底。我们自己的 woff2 子集由 web 服务经 /fonts/ 提供，
#     不进本镜像 —— 渲染是通过 HTTP 抓取页面的，字体随页面一起来
#   - 非 root 运行；Playwright 镜像自带 pwuser，但我们统一用数值 UID 10001
#   - 部署时必须给 /dev/shm 至少 1Gi，否则 Chromium 崩溃（L-07）
#
# 构建（从仓库根）：
#   docker build --platform=linux/amd64 -f deploy/images/render-worker.Dockerfile -t tps/render-worker .

# 必须与 apps/render-worker 的 playwright-core 版本**完全一致**。
# 不一致时镜像里的浏览器目录名与库期望的对不上，报
# "Executable doesn't exist at /ms-playwright/chromium-xxxx" —— 与版本毫无关联的错误。
# 由 apps/render-worker/src/image-version.test.ts 断言两处同步。
ARG PLAYWRIGHT_VERSION=1.62.1

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

# ── 依赖与构建层（复用通用 Node 基底，构建不需要 Chromium）────
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable

WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# 全部 workspace 包的 package.json（含根 package.json），目录结构与仓库一致
COPY --from=manifests /manifests/ ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json turbo.json ./
COPY tools/ tools/
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm --filter "@tps/render-worker..." run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    # deploy 只接受**单个**项目。用 "@tps/x..."（含依赖）会展开成多个包，
    # 报 ERR_PNPM_CANNOT_DEPLOY_MANY。workspace 依赖由 deploy 自行解析并注入 /out，
    # 所以不需要（也不能）在这里列出它们。
    pnpm --filter "@tps/render-worker" deploy --legacy --prod /out

# ── 运行层 ────────────────────────────────────────────────
# 全局 ARG 在这里生效，保证 FROM 与上面的版本号是同一处定义
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS runtime

ENV NODE_ENV=production \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORT=3012 \
    NODE_OPTIONS=--enable-source-maps \
    # 与基线截图一致的字体渲染（设计稿 22.3.2）
    CHROMIUM_FONT_RENDER_HINTING=none

USER root

# DEBIAN_FRONTEND=noninteractive 不能省：tzdata 的 postinst 会交互式询问时区，
# 而构建没有 tty —— 表现是**构建永久挂住**而不是报错。
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tzdata tini fontconfig \
      fonts-noto-cjk fonts-noto-cjk-extra \
 && rm -rf /var/lib/apt/lists/*

# L-04：字体缓存必须真的建立，且必须能查到 Noto。
#
# 在**构建期**断言而不是运行期检查：字体缺失的运行期表现是豆腐块 PNG ——
# 任务成功、监控全绿、只有用户看得见。在这里失败等于让缺陷进不了镜像。
RUN fc-cache -f \
 && count="$(fc-list | grep -ci noto || true)" \
 && echo "fc-list 中 Noto 字体数：$count" \
 && test "$count" -ge 1 || { echo 'L-04 失败：镜像内无 Noto 字体'; exit 1; }

RUN groupadd --gid 10001 tps \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin tps

WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./

# L-05：sharp 的 linux-x64 预编译二进制必须可加载（22.3.2）。
#
# 这是 pnpm「只装宿主平台可选依赖」陷阱的落点：Windows 上装出来的
# node_modules 拷进镜像后 sharp 会在**第一次导出 PNG 时**才报错，
# 而那时任务已经渲染完了。构建期加载一次就能提前发现。
RUN node -e "const s=require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips);"

USER 10001:10001
EXPOSE 3012

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/main.js"]
