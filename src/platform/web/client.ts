import { desktopAdminToken } from "../desktop/bridge";
import { isDesktopHost } from "../desktop/mode";

const TOKEN_KEY = "flowlet.web.admin-token";

let csrfToken = "";

export type WebAuthMode = "token" | "oidc";

export type WebAuthConfig = {
  mode: WebAuthMode;
  provider: { display_name?: string | null };
  /** 已配置的登录提供方；多个时登录页各给一个按钮。 */
  providers?: Array<{ id: string; display_name: string }>;
  login_path: string;
  token_login: boolean;
};

export type WebIdentity = {
  email?: string | null;
  username?: string | null;
  name?: string | null;
  provider?: string | null;
  /** `admin` 全权、`viewer` 只读；旧服务端可能不返回，按 admin 处理。 */
  role?: string | null;
};

export type WebSession = {
  authenticated: boolean;
  mode: WebAuthMode;
  identity?: WebIdentity | null;
  csrf_token?: string | null;
};

/**
 * Electron desktop 壳的 401：管理 token 由主进程注入，没有登录页可跳转，
 * 也不应清空任何用户数据；抛可重试错误，交给 TanStack Query / 调用方重试。
 */
export class WebCommandUnauthorizedError extends Error {
  readonly status = 401;
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "WebCommandUnauthorizedError";
  }
}

/**
 * 管理 token：Web Host（Docker / 浏览器）来自 sessionStorage；
 * Electron desktop 壳没有登录页，由 preload 注入 `window.flowletDesktop.adminToken`，
 * 因此 sessionStorage 为空时回退到 preload 桥。
 */
export function adminToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? desktopAdminToken();
}

export function setAdminToken(value: string) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function currentCsrfToken() {
  return csrfToken;
}

export async function fetchAuthConfig(): Promise<WebAuthConfig> {
  const response = await fetch("/api/auth/config", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取管理端认证配置");
  return (await response.json()) as WebAuthConfig;
}

/** True when the browser already has a valid management session. */
export async function fetchWebSession(): Promise<WebSession | null> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`读取登录状态失败 (${response.status})`);
  const session = (await response.json()) as WebSession;
  csrfToken = session.csrf_token ?? "";
  return session;
}

export async function verifyAdminToken(token: string) {
  const response = await fetch("/api/session", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("管理凭据无效");
}

export async function logoutWebSession() {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers,
    cache: "no-store",
  }).catch(() => undefined);
  csrfToken = "";
}

export async function invokeWebCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = adminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // desktop 壳没有 Cookie 会话，也不存在 CSRF 校验；不要发空的 CSRF 头。
  if (!isDesktopHost && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`/api/commands/${encodeURIComponent(command)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) {
    if (isDesktopHost) {
      // desktop：preload token 无效/过期时不清用户数据、不触发登录跳转，只抛可重试错误。
      const unauthorized = await response
        .json()
        .catch(() => ({}) as { message?: string });
      throw new WebCommandUnauthorizedError(
        unauthorized.message ?? "管理凭据无效，请重新登录",
      );
    }
    setAdminToken("");
    csrfToken = "";
    window.dispatchEvent(new Event("flowlet-web-unauthorized"));
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? `请求失败 (${response.status})`);
  return result as T;
}
