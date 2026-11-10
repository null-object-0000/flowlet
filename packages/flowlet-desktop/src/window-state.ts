// 主窗口尺寸/位置/最大化记忆。
//
// Rust 使用 tauri-plugin-window-state（只恢复 SIZE | POSITION | MAXIMIZED，不恢复
// VISIBLE）。这里等价实现为数据目录下的 JSON；启动后按显示器 workArea 校正，
// 避免上次关闭位置在多屏变化后落到屏幕外。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";
import { screen } from "electron";

export const MIN_CONTENT_WIDTH = 1200;
export const MIN_CONTENT_HEIGHT = 720;
export const DEFAULT_CONTENT_WIDTH = 1200;
export const DEFAULT_CONTENT_HEIGHT = 720;

export interface StoredWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const STATE_FILE = "window-state.json";

export function loadWindowState(dataDir: string): StoredWindowState | null {
  const file = join(dataDir, STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredWindowState>;
    if (typeof raw.width !== "number" || typeof raw.height !== "number") return null;
    return {
      x: typeof raw.x === "number" ? raw.x : undefined,
      y: typeof raw.y === "number" ? raw.y : undefined,
      width: Math.max(MIN_CONTENT_WIDTH, Math.round(raw.width)),
      height: Math.max(MIN_CONTENT_HEIGHT, Math.round(raw.height)),
      maximized: raw.maximized === true,
    };
  } catch {
    return null;
  }
}

export function saveWindowState(dataDir: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const maximized = win.isMaximized();
  // 最大化时 getBounds 是最大化后的尺寸；恢复前应保存 normal bounds，避免下次
  // 取消最大化后窗口变成全屏大小。Electron 提供 getNormalBounds。
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  const state: StoredWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized,
  };
  try {
    writeFileSync(join(dataDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 窗口状态只是体验优化，写入失败不应阻塞关闭/退出。
  }
}

/** 把窗口拉回可见显示器；等价 Rust `window_visibility::ensure_window_on_screen`。 */
export function ensureWindowOnScreen(win: BrowserWindow, bounds: Rectangle): Rectangle {
  const displays = screen.getAllDisplays();
  const centerX = bounds.x + Math.floor(bounds.width / 2);
  const centerY = bounds.y + Math.floor(bounds.height / 2);
  const display =
    displays.find(({ workArea }) => {
      return (
        centerX >= workArea.x &&
        centerX < workArea.x + workArea.width &&
        centerY >= workArea.y &&
        centerY < workArea.y + workArea.height
      );
    }) ?? screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) {
    return bounds;
  }
  win.setBounds({ x, y, width, height });
  return { x, y, width, height };
}