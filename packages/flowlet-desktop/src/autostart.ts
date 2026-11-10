// 开机自启。
//
// - Windows / macOS：`app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`；
// - Linux：`setLoginItemSettings` 不支持，写 XDG autostart `.desktop`
//   （`$XDG_CONFIG_HOME/autostart/flowlet.desktop`，默认 `~/.config/autostart`），
//   与 Tauri autostart 插件等价。
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DesktopLogger } from "./logger.ts";

const LINUX_DESKTOP_FILE = "flowlet.desktop";

function linuxAutostartPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  const base = configHome && configHome !== "" ? configHome : join(homedir(), ".config");
  return join(base, "autostart", LINUX_DESKTOP_FILE);
}

/** 自启时真正需要执行的路径：AppImage 用 $APPIMAGE，否则用 exe。 */
function execPath(): string {
  const appImage = process.env.APPIMAGE;
  if (appImage && appImage !== "") return appImage;
  return app.getPath("exe");
}

function quoteDesktopExec(value: string): string {
  // Desktop Entry 规范：Exec 参数中的引号/反斜杠需转义；这里是本机路径，
  // 仍按规范处理空格与双引号。
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class AutostartController {
  private readonly logger: DesktopLogger;

  constructor(logger: DesktopLogger) {
    this.logger = logger;
  }

  get(): boolean {
    if (process.platform === "linux") {
      const file = linuxAutostartPath();
      if (!existsSync(file)) return false;
      try {
        return readFileSync(file, "utf8").includes("--hidden");
      } catch {
        return true;
      }
    }
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch (error) {
      this.logger.warn("读取开机自启状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  set(enabled: boolean): void {
    if (process.platform === "linux") {
      const file = linuxAutostartPath();
      if (!enabled) {
        rmSync(file, { force: true });
        return;
      }
      const exec = `${quoteDesktopExec(execPath())} --hidden`;
      const content = [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.0",
        "Name=Flowlet",
        "Comment=Flowlet 本地模型服务控制台",
        `Exec=${exec}`,
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "StartupNotify=false",
        "Categories=Utility;",
        "",
      ].join("\n");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: 0o644 });
      return;
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: ["--hidden"],
      });
    } catch (error) {
      this.logger.warn("写入开机自启失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`写入开机自启失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}