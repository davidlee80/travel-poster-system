# Web 镜像（Next.js standalone）
#
# 依赖 next.config.mjs 的 `output: 'standalone'`：产出自带最小 node_modules 的
# 独立目录，镜像不必包含 pnpm store，也不必在镜像里重新 install。
#
# 构建（从仓库根）：
#   docker build --platform=linux/amd64 -f deploy/images/web.Dockerfile -t tps/web .

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
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

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata tini ca-certificates \
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
