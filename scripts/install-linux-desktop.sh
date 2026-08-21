#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ID="site.snewbie.flowlet"
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
APPLICATIONS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
DESKTOP_FILE="$APPLICATIONS_DIR/$APP_ID.desktop"
ICON_FILE="$ICON_DIR/$APP_ID.png"

if [ ! -x "$SCRIPT_DIR/flowlet" ]; then
  echo "未找到可执行的 Flowlet：$SCRIPT_DIR/flowlet" >&2
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/flowlet.png" ]; then
  echo "未找到 Flowlet 图标：$SCRIPT_DIR/flowlet.png" >&2
  exit 1
fi

mkdir -p "$APPLICATIONS_DIR" "$ICON_DIR"
cp "$SCRIPT_DIR/flowlet.png" "$ICON_FILE"

{
  echo "[Desktop Entry]"
  echo "Type=Application"
  echo "Version=1.0"
  echo "Name=Flowlet"
  echo "Comment=Local AI model service console"
  # Portable Tauri/GTK currently exposes a stable Flowlet WM_CLASS under X11.
  # Force XWayland for this launcher only so GNOME can associate the running
  # window with this desktop entry instead of showing a generic gear icon.
  printf 'Exec=env GDK_BACKEND=x11 "%s/flowlet"\n' "$SCRIPT_DIR"
  printf 'TryExec=%s/flowlet\n' "$SCRIPT_DIR"
  echo "Icon=$APP_ID"
  echo "Terminal=false"
  echo "StartupNotify=true"
  echo "StartupWMClass=Flowlet"
  echo "Categories=Development;"
} > "$DESKTOP_FILE"

chmod 644 "$DESKTOP_FILE" "$ICON_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Flowlet 桌面启动器已安装：$DESKTOP_FILE"
echo "请从应用菜单启动 Flowlet；Ubuntu Dock 将使用 Flowlet logo。"
