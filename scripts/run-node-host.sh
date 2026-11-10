#!/usr/bin/env bash
# 本地以「与 Docker 镜像一致」的环境变量运行 Node Host（不经过 docker）。
#
# 用法：scripts/run-node-host.sh [数据副本路径]
# 默认会从 FLOWLET_FIXTURE_DB（或内置默认路径）复制一份数据库到 .flowlet-dev-data/，
# 避免写入真实数据；复制后 Node Host 在该副本上读写。
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="${FLOWLET_DEV_DATA:-$PWD/.flowlet-dev-data}"
FIXTURE_DB="${1:-${FLOWLET_FIXTURE_DB:-/home/nichangen/.local/state/flowlet-docker-migration-20261109/flowlet.sqlite}}"
mkdir -p "$DATA_DIR/catalogs"
if [[ ! -f "$DATA_DIR/flowlet.sqlite" ]]; then
  echo "初始化数据库副本：$FIXTURE_DB -> $DATA_DIR/flowlet.sqlite"
  cp "$FIXTURE_DB" "$DATA_DIR/flowlet.sqlite"
fi

export FLOWLET_ADMIN_TOKEN="${FLOWLET_ADMIN_TOKEN:-dev-admin-token-0123456789abcdef}"
export FLOWLET_CLIENT_TOKEN="${FLOWLET_CLIENT_TOKEN:-dev-client-token-0123456789abcdef}"
export FLOWLET_DB_PATH="$DATA_DIR/flowlet.sqlite"
export FLOWLET_CONFIG_PATH="$DATA_DIR/config.json"
export FLOWLET_CATALOG_DIR="$DATA_DIR/catalogs"
export FLOWLET_STATIC_DIR="${FLOWLET_STATIC_DIR:-$PWD/dist-web}"
export FLOWLET_WEB_ADDR="${FLOWLET_WEB_ADDR:-127.0.0.1:8080}"
export FLOWLET_BIND_ADDR="${FLOWLET_BIND_ADDR:-127.0.0.1:18640}"

exec node packages/flowlet-core/src/index.ts
