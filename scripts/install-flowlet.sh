#!/bin/sh
# Flowlet CLI + Skills 安装脚本（POSIX sh，无 sudo，幂等）。
#
# 用法：
#   curl -fsSL http://host:20134/downloads/install-flowlet.sh \
#     | sh -s -- --base=http://host:20134/downloads
#
#   ./install-flowlet.sh --base=http://host:20134/downloads \
#     [--prefix="$HOME/.local"] [--skills-dir=DIR] [--no-skills]
#
# 安装布局：
#   ${XDG_DATA_HOME:-$PREFIX/share}/flowlet/cli    CLI 文件（含 node_modules/undici）
#   ${XDG_BIN_HOME:-$PREFIX/bin}/flowlet           -> .../cli/bin/<bin>
#
# 校验：从 --base 下载 manifest.json，用 node:crypto 校验每个产物的 sha256（不依赖 jq）。

set -eu

BASE=""
PREFIX="${HOME}/.local"
SKILLS_DIR=""
INSTALL_SKILLS=1

usage() {
  cat <<'EOF'
Flowlet CLI 安装脚本（需要 Node.js 22.6+）

用法：
  install-flowlet.sh --base=<下载地址前缀> [选项]

选项：
  --base=<URL>        必填。下载产物地址前缀，例如 http://host:20134/downloads
  --prefix=<DIR>      安装前缀，默认 $HOME/.local
  --skills-dir=<DIR>  可选。安装 Skills 包到该目录（生成 <DIR>/flowlet-credentials/SKILL.md）
  --no-skills         不安装 Skills
  -h, --help          显示本帮助

示例：
  curl -fsSL http://host:20134/downloads/install-flowlet.sh \
    | sh -s -- --base=http://host:20134/downloads
EOF
}

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --base=*) BASE="${arg#--base=}" ;;
    --prefix=*) PREFIX="${arg#--prefix=}" ;;
    --skills-dir=*) SKILLS_DIR="${arg#--skills-dir=}" ;;
    --no-skills) INSTALL_SKILLS=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$arg（用 -h 查看用法）"
      ;;
  esac
done

[ -n "${HOME:-}" ] || fail "安装脚本需要 HOME 环境变量"
[ -n "$BASE" ] || {
  usage >&2
  fail "缺少 --base=<下载地址前缀>"
}
BASE="${BASE%/}"
[ -n "$PREFIX" ] || fail "--prefix 不能为空"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flowlet-install.XXXXXX")" || fail "无法创建临时目录"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup 0
trap 'exit 1' 1 2 15

# ─── 依赖检查 ─────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || fail "未找到 node。Flowlet CLI 需要 Node.js 22.6+，请先安装：https://nodejs.org/"
# 与 bin/flowlet.mjs 保持一致：Node ≥ 22.6 可用（22.6–22.17 由入口自动补
# --experimental-strip-types，22.18+/23.6+ 默认开启；< 22.6 明确报错）。
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1);
'; then
  fail "Node.js 版本过低（当前 $(node --version)）；Flowlet CLI 需要 Node.js 22.6+"
fi

# ─── 下载 / 校验 ─────────────────────────────────────────────────────────

download() {
  # $1=URL  $2=目标文件
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || fail "下载失败：$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2" || fail "下载失败：$1"
  else
    fail "未找到 curl 或 wget，无法下载 Flowlet 安装产物"
  fi
}

verify_artifact() {
  # $1=manifest 中的 artifact 路径  $2=本地文件
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [manifestPath, filePath, artifactName] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const artifact = (manifest.artifacts || []).find(
      (item) => item.path === artifactName || String(item.path).endsWith("/" + artifactName),
    );
    if (!artifact) {
      console.error("manifest 中缺少产物：" + artifactName);
      process.exit(1);
    }
    const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (digest !== artifact.sha256) {
      console.error("sha256 校验失败：" + artifactName);
      process.exit(1);
    }
  ' "$TMP_DIR/manifest.json" "$2" "$1" || fail "校验 $1 失败"
}

download "$BASE/manifest.json" "$TMP_DIR/manifest.json"
VERSION="$(
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!manifest.version) process.exit(1);
    process.stdout.write(String(manifest.version));
  ' "$TMP_DIR/manifest.json"
)" || fail "manifest.json 无法解析或缺少 version"

# ─── 安装 CLI ────────────────────────────────────────────────────────────

download "$BASE/flowlet-cli.tar.gz" "$TMP_DIR/flowlet-cli.tar.gz"
verify_artifact "flowlet-cli.tar.gz" "$TMP_DIR/flowlet-cli.tar.gz"

mkdir -p "$TMP_DIR/extract"
tar -xzf "$TMP_DIR/flowlet-cli.tar.gz" -C "$TMP_DIR/extract" || fail "解压 flowlet-cli.tar.gz 失败"
[ -d "$TMP_DIR/extract/flowlet-cli" ] || fail "CLI 安装包结构不正确（缺少 flowlet-cli/）"

DATA_ROOT="${XDG_DATA_HOME:-$PREFIX/share}"
CLI_DIR="$DATA_ROOT/flowlet/cli"
BIN_DIR="${XDG_BIN_HOME:-$PREFIX/bin}"

mkdir -p "$(dirname "$CLI_DIR")"
rm -rf "$CLI_DIR"
mv "$TMP_DIR/extract/flowlet-cli" "$CLI_DIR" || fail "安装到 $CLI_DIR 失败"

BIN_REL="$(
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const target = pkg.bin && pkg.bin.flowlet;
    if (!target) process.exit(1);
    process.stdout.write(String(target).replace(/^\.\//, ""));
  ' "$CLI_DIR/package.json"
)" || fail "CLI 包缺少 flowlet bin 声明"
[ -f "$CLI_DIR/$BIN_REL" ] || fail "CLI 入口不存在：$CLI_DIR/$BIN_REL"
chmod +x "$CLI_DIR/$BIN_REL"

mkdir -p "$BIN_DIR"
ln -sf "$CLI_DIR/$BIN_REL" "$BIN_DIR/flowlet" || fail "创建符号链接失败：$BIN_DIR/flowlet"

# ─── 安装 Skills（可选） ──────────────────────────────────────────────────

if [ "$INSTALL_SKILLS" -eq 1 ] && [ -n "$SKILLS_DIR" ]; then
  download "$BASE/flowlet-skills.tar.gz" "$TMP_DIR/flowlet-skills.tar.gz"
  verify_artifact "flowlet-skills.tar.gz" "$TMP_DIR/flowlet-skills.tar.gz"

  mkdir -p "$TMP_DIR/skills"
  tar -xzf "$TMP_DIR/flowlet-skills.tar.gz" -C "$TMP_DIR/skills" || fail "解压 flowlet-skills.tar.gz 失败"
  [ -d "$TMP_DIR/skills/flowlet-skills" ] || fail "Skills 包结构不正确（缺少 flowlet-skills/）"
  mkdir -p "$SKILLS_DIR"
  cp -R "$TMP_DIR/skills/flowlet-skills/." "$SKILLS_DIR/" || fail "安装 Skills 到 $SKILLS_DIR 失败"
  printf '已安装 Skills：%s/flowlet-credentials/SKILL.md\n' "$SKILLS_DIR"
elif [ "$INSTALL_SKILLS" -eq 1 ]; then
  printf '提示：未指定 --skills-dir，跳过 Skills 安装（可用 --skills-dir=<目录> 安装）。\n'
fi

# ─── 输出 ────────────────────────────────────────────────────────────────

printf '\n已安装 Flowlet CLI %s\n' "$VERSION"
printf '  可执行文件：%s\n' "$BIN_DIR/flowlet"
INSTALLED_VERSION="$("$BIN_DIR/flowlet" --version 2>/dev/null || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  printf '  自检：%s\n' "$INSTALLED_VERSION"
fi

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    printf 'PATH 提示：%s 不在 PATH 中，请加入 shell 配置，例如：\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\n下一步：\n'
printf '  flowlet --help\n'
printf '  flowlet init\n'