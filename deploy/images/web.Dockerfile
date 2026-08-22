# Web 镜像（Next.js standalone）
#
# 依赖 next.config.mjs 的 `output: 'standalone'`：产出自带最小 node_modules 的
# 独立目录，镜像不必包含 pnpm store，也不必在镜像里重新 install。
#
# 构建（从仓库根）：
#   docker build --platform=linux/amd64 -f deploy/images/web.Dockerfile -t tps/web .

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

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
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

# `/legal` 页面在构建期读这份 markdown 并渲染成静态页（单一真相源仍是 docs
# 那一份，见 apps/web/src/lib/legal-document.ts）。**只拷这一个文件**而不是
# 整个 docs/：设计稿与计划文档进镜像层没有意义，而它们是这个仓库里最大的文本。
#
# 少了这一行的表现是构建直接失败（readFileSync 抛错）—— 这是刻意的，
# 兜底成「渲染一个空政策页」会让缺失的政策悄悄上线。
COPY "docs/用户协议与隐私政策.md" docs/

RUN pnpm --filter "@tps/web..." run build

# ── 运行层 ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# DEBIAN_FRONTEND=noninteractive 不能省：tzdata 的 postinst 会交互式询问时区，
# 而构建没有 tty —— 表现是**构建永久挂住**而不是报错。
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 tps \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin tps

WORKDIR /app

# standalone 产物 + 静态资源。.next/static 必须单独拷贝，standalone 不含它。
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=10001:10001 /repo/apps/web/public ./apps/web/public

USER 10001:10001
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "apps/web/server.js"]
