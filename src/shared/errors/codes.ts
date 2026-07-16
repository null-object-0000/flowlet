/* Stable error code catalog shared across domain adapters and UI layers.
   Codes are NOT derived from parsing user-visible strings. Rust side returns
   free-form Err(String); we map known situations where possible and fall back
   to generic codes otherwise. Keep this list small and intentional. */

export const ErrorCode = {
  // Generic / transport
  Unknown: "unknown",
  Timeout: "timeout",
  InvokeFailed: "invoke_failed",

  // Proxy lifecycle
  ProxyStartFailed: "proxy_start_failed",
  ProxyStopFailed: "proxy_stop_failed",
  ProxyAlreadyRunning: "proxy_already_running",
  ProxyNotRunning: "proxy_not_running",
  InvalidBindAddr: "invalid_bind_addr",

  // Upstream / account
  UpstreamAuthInvalid: "upstream_auth_invalid",
  UpstreamUnavailable: "upstream_unavailable",

  // Storage / backend
  StorageLocked: "storage_locked",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
