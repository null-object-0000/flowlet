const TOKEN_KEY = "flowlet.web.admin-token";

let csrfToken = "";

export type WebAuthMode = "token" | "oidc";

export type WebAuthConfig = {
  mode: WebAuthMode;
  provider: { display_name?: string | null };
  login_path: string;
  token_login: boolean;
};

export type WebIdentity = {
  email?: string | null;
  username?: string | null;
  name?: string | null;
  provider?: string | null;
};

export type WebSession = {
  authenticated: boolean;
  mode: WebAuthMode;
  identity?: WebIdentity | null;
  csrf_token?: string | null;
};

export function adminToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
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
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`/api/commands/${encodeURIComponent(command)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) {
    setAdminToken("");
    csrfToken = "";
    window.dispatchEvent(new Event("flowlet-web-unauthorized"));
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? `请求失败 (${response.status})`);
  return result as T;
}
