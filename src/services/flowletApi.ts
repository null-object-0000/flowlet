import { invoke } from "@tauri-apps/api/core";

// 单个 Tauri 命令的请求超时（毫秒）。默认 15s。超时时 reject，
// 让调用方的 .catch 逻辑兜底到空默认值，避免 Promise.all 被单个慢查询卡死。
const DEFAULT_TIMEOUT_MS = 15_000;

export function runCommand<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`invoke timeout: ${command}`));
    }, timeoutMs);

    invoke<T>(command, args)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// 前端日志落盘（写到 Rust tracing 的同一个文件里）。
//
// 注意：此函数内部会 invoke 一个 Tauri 命令，会加剧 React 状态更新压力。
// 仅在**非高频路径**（用户操作、错误处理、关闭清理）里调用。绝对不要在：
//   * React useEffect 中调用
//   * React render 流程中调用
//   * 任何热路径中调用
//
// 否则会触发循环：invoke → Tauri 响应 → React 状态 setter → re-render → useEffect → 再 invoke → ...
let LOG_ENABLED = false;
export function logToRust(level: "info" | "warn" | "error" | "debug", message: string) {
  if (!LOG_ENABLED) return;
  runCommand<null>("log_from_frontend", { level, message }, 2_000).catch(() => {
    // 失败时禁用自身以避免反复重试让循环更糟
    LOG_ENABLED = false;
  });
}

// 立即禁用前端日志，直到首屏渲染完成后（在 App.tsx 中调用）
export function disableFrontendLogging() {
  LOG_ENABLED = false;
}
export function enableFrontendLogging() {
  LOG_ENABLED = true;
}
