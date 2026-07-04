FROM rust:1.85-slim AS builder

RUN apt-get update && apt-get install -y \
    pkg-config libssl-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./
COPY src-tauri/src ./src

RUN cargo build --release --bin headless

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates libssl3 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/headless /usr/local/bin/headless

ENV FLOWLET_BIND_ADDR=0.0.0.0:18640
ENV FLOWLET_WEB_ADDR=0.0.0.0:8080
ENV FLOWLET_DB_PATH=/data/flowlet.sqlite
ENV RUST_LOG=info

VOLUME ["/data"]
EXPOSE 18640 8080

ENTRYPOINT ["headless"]
