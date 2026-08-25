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
  # 运行在原生 Wayland 后端：XWayland 下 GNOME Shell 最小化/恢复窗口时
  # 会出现整窗闪烁，原生 Wayland 由合成器原生动画，不存在该问题。
  # 不再强制 GDK_BACKEND=x11。
  printf 'Exec="%s/flowlet"\n' "$SCRIPT_DIR"
  printf 'TryExec=%s/flowlet\n' "$SCRIPT_DIR"
  echo "Icon=$APP_ID"
  echo "Terminal=false"
  echo "StartupNotify=true"
  # Wayland 下 GNOME 通过 app_id（= APP_ID，见 tauri.conf.json 的
  # enableGTKAppId）关联窗口与桌面入口；X11 会话回退时 WM_CLASS 也取自
  # GTK application id，因此统一填 APP_ID。
  echo "StartupWMClass=$APP_ID"
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
