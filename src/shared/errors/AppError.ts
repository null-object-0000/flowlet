/** Application-level error contract used across the new frontend.
 *  Pages/components consume `AppError`; domain adapters map transport /
 *  command failures into it. */
export type AppError = {
  /** Stable code from shared/errors/codes.ts or a domain-specific string. */
  code: string;
  /** User-visible summary (Chinese). */
  message: string;
  /** Optional technical detail for troubleshooting / devtools. never shown
   *  directly to non-technical users and must not contain secrets. */
  detail?: string;
  /** Whether the failing action is safe for the user / UI to retry. */
  retryable: boolean;
};

/** Extract a user-visible message from errors crossing domain boundaries.
 * Domain commands reject with plain `AppError` objects, so `instanceof Error`
 * alone is insufficient and would otherwise render as `[object Object]`. */
export function errorMessage(error: unknown, fallback = "未知错误"): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}
