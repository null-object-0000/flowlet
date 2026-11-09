const TOKEN_KEY = "flowlet.web.admin-token";
export function adminToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}
export function setAdminToken(value: string) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}
export async function verifyAdminToken(token: string) {
  const response = await fetch("/api/session", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("管理凭据无效");
}
export async function invokeWebCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`/api/commands/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args ?? {}),
    cache: "no-store",
  });
  if (response.status === 401) {
    setAdminToken("");
    window.dispatchEvent(new Event("flowlet-web-unauthorized"));
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? `请求失败 (${response.status})`);
  return result as T;
}
