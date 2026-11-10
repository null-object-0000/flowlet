// 远程会话状态的纯函数（不 import electron），便于 node:test 直接覆盖。
//
// 输入来自远程 Web Host 的 `GET /api/session` 响应：
// `{ authenticated, mode: "token"|"oidc", identity?: {email|username|name}, csrf_token? }`。
// Cookie 来自 Electron `session.cookies.get()`（字段为 `{name, value}`）。
export type RemoteAuthMode = "token" | "oidc" | "unknown";

export interface RemoteSessionSnapshot {
  authenticated: boolean;
  mode: RemoteAuthMode;
  /** 展示用身份（email > username > name），没有则为 null。 */
  identity: string | null;
  /** OIDC 会话的 CSRF token；token 模式通常为 null。 */
  csrf: string | null;
}

export const EMPTY_REMOTE_SESSION: RemoteSessionSnapshot = {
  authenticated: false,
  mode: "unknown",
  identity: null,
  csrf: null,
};

/** 把 Electron cookie 数组拼成 `Cookie` 头；跳过缺 name/value 的脏数据。 */
export function buildCookieHeader(cookies: ReadonlyArray<{ name?: unknown; value?: unknown }>): string {
  const parts: string[] = [];
  for (const cookie of cookies) {
    if (typeof cookie.name !== "string" || cookie.name === "") continue;
    if (typeof cookie.value !== "string") continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join("; ");
}

export function parseRemoteSessionPayload(raw: unknown): RemoteSessionSnapshot {
  if (raw === null || typeof raw !== "object") return { ...EMPTY_REMOTE_SESSION };
  const value = raw as Record<string, unknown>;
  const authenticated = value.authenticated === true;
  const mode: RemoteAuthMode = value.mode === "oidc" ? "oidc" : value.mode === "token" ? "token" : "unknown";
  const identityRaw = value.identity;
  let identity: string | null = null;
  if (identityRaw !== null && typeof identityRaw === "object") {
    const record = identityRaw as Record<string, unknown>;
    for (const key of ["email", "username", "name"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "") {
        identity = candidate.trim();
        break;
      }
    }
  }
  const csrfRaw = value.csrf_token;
  const csrf = typeof csrfRaw === "string" && csrfRaw !== "" ? csrfRaw : null;
  return { authenticated, mode, identity, csrf };
}
