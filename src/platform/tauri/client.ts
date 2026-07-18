import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "../../shared/errors/AppError";

/**
 * Default timeout (ms) for a single Tauri command invoke. The invoke itself
 * never truly "hangs" in the browser sense, but a stuck async command should
 * surface as a retryable error rather than an orphan promise. Keep modest so
 * UI loading states resolve in a timely way. Individual calls may override.
 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 15_000;

export type CommandArguments = Record<string, unknown>;

/**
 * An error thrown by `invokeCommand` when the underlying Tauri invoke rejects.
 * It is intentionally NOT an `AppError` so callers that want the raw shape can
 * still narrow on it before domain mapping turns it into an `AppError`.
 */
export class InvokeError extends Error {
  readonly command: string;
  readonly retryable: boolean;

  constructor(command: string, message: string, retryable = true) {
    super(message);
    this.name = "InvokeError";
    this.command = command;
    this.retryable = retryable;
  }
}

function normalizeInvokeFailure(command: string, err: unknown): InvokeError {
  if (err instanceof InvokeError) {
    return err;
  }
  // Rust commands return `Result<T, String>`; Tauri surfaces the `Err` side as
  // a string. Timeout also reaches here with our own message prefix.
  const message = err instanceof Error ? err.message : String(err ?? "未知错误");
  const timeout = message.includes("timeout");
  return new InvokeError(command, message, !timeout);
}

/**
 * Typed Tauri invoke with explicit timeout. NEVER swallows rejections:
 * every failure (including timeout) rejects the returned promise so the
 * caller / TanStack Query can model it as a genuine error instead of an
 * empty default. Domains should wrap this and map `InvokeError` into typed
 * `AppError` values; pages/components must not call `invoke` directly.
 */
export function invokeCommand<TResult>(
  command: string,
  args?: CommandArguments,
  timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const call = invoke<TResult>(command, args).then(
    (value) => value,
    (err: unknown) => {
      throw normalizeInvokeFailure(command, err);
    },
  );

  if (!Number.isFinite(timeoutMs)) {
    return call;
  }

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new InvokeError(command, `invoke timeout: ${command}`, true));
    }, timeoutMs);
  });

  return Promise.race([call, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Convert any thrown value into an `AppError`. Used by domain layers to keep
 * page/components free of command-string and low-level error parsing. Do NOT
 * derive business decisions from parsing `message` strings downstream.
 */
export function toAppError(err: unknown, fallbackCode = "unknown"): AppError {
  if (err && typeof err === "object" && "code" in err) {
    const candidate = err as Partial<AppError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        detail: candidate.detail,
        retryable: candidate.retryable ?? false,
      };
    }
  }
  const message = err instanceof Error ? err.message : String(err ?? "未知错误");
  return {
    code: fallbackCode,
    message,
    detail: err instanceof InvokeError ? err.command : undefined,
    retryable: !(err instanceof InvokeError) || err.retryable,
  };
}
