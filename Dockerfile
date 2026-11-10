# syntax=docker/dockerfile:1
# Flowlet Docker image — Node Host (migration: replaces the Rust headless binary).
# Two build stages: the unchanged web UI bundle, then the Node host source+deps.
# Runtime stage keeps the原 deployment contract: non-root 10001, /data volume,
# ports 8080 (web) / 18640 (model entry), /health healthcheck, SIGTERM shutdown.

FROM node:26-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY website/package.json ./website/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY model-catalog.json plugin-registry.json ./
RUN npm run build:web

# 只安装 flowlet-core 的运行时依赖（undici）；服务端其余全部使用 Node 内置模块。
FROM node:26-bookworm-slim AS server-deps
WORKDIR /app/packages/flowlet-core
COPY packages/flowlet-core/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 运行阶段不安装任何 apt 包：健康检查用 Node 内置 fetch（见 healthcheck.mjs），
# 避免构建期拉 Debian 源（远端构建最主要的卡点）。
FROM node:26-bookworm-slim
RUN groupadd --gid 10001 flowlet \
    && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home flowlet \
    && mkdir -p /data/catalogs /app/ui && chown -R flowlet:flowlet /data

# 仓库布局对齐：REPO_ROOT = /app（index.ts 从 packages/flowlet-core/src 上溯 4 级）
WORKDIR /app
COPY config.json model-catalog.json plugin-registry.json ./
COPY packages/flowlet-core/package.json ./packages/flowlet-core/package.json
COPY packages/flowlet-core/tsconfig.json ./packages/flowlet-core/tsconfig.json
COPY packages/flowlet-core/src ./packages/flowlet-core/src
COPY packages/flowlet-core/healthcheck.mjs ./packages/flowlet-core/healthcheck.mjs
COPY --from=server-deps /app/packages/flowlet-core/node_modules ./packages/flowlet-core/node_modules
COPY --from=web /src/dist-web /app/ui

# 源码/静态资源只需可读：本地工作区的文件权限可能是 0600（agent 写入），
# 而容器以 10001 运行；统一放开读权限，可写目录只有 /data（已 chown）。
RUN chmod -R a+rX /app

ENV FLOWLET_BIND_ADDR=0.0.0.0:18640 \
    FLOWLET_WEB_ADDR=0.0.0.0:8080 \
    FLOWLET_DB_PATH=/data/flowlet.sqlite \
    FLOWLET_STATIC_DIR=/app/ui \
    FLOWLET_CATALOG_DIR=/data/catalogs

USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 18640 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "/app/packages/flowlet-core/healthcheck.mjs"]
STOPSIGNAL SIGTERM
# Node 26 直接执行 TypeScript（类型剥离，无构建产物）
ENTRYPOINT ["node", "/app/packages/flowlet-core/src/index.ts"]
