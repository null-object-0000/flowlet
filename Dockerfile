# syntax=docker/dockerfile:1
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

FROM rust:1.97-slim-bookworm AS server
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends pkg-config g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY .cargo ./.cargo
COPY config.json model-catalog.json plugin-registry.json ./
COPY src-tauri ./src-tauri
WORKDIR /src/src-tauri
RUN cargo build --locked --release --no-default-features --bin headless

FROM debian:bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 flowlet \
    && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home flowlet \
    && mkdir -p /data/catalogs /app/ui && chown -R flowlet:flowlet /data
COPY --from=server /src/src-tauri/target/release/headless /usr/local/bin/flowlet-server
COPY --from=web /src/dist-web /app/ui
ENV FLOWLET_BIND_ADDR=0.0.0.0:18640 \
    FLOWLET_WEB_ADDR=0.0.0.0:8080 \
    FLOWLET_DB_PATH=/data/flowlet.sqlite \
    FLOWLET_STATIC_DIR=/app/ui \
    FLOWLET_CATALOG_DIR=/data/catalogs \
    RUST_LOG=info
USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 18640 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/health || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["flowlet-server"]
