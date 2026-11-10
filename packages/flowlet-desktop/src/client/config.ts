// 桌面运行模式与远程主机连接配置（纯函数，不 import electron）。
//
// 存储形态（`<userData>/desktop-config.json`）：
// {
//   "version": 1,
//   "mode": "host" | "client",
//   "client": { "baseUrl": "https://flowlet.example.com", "auth": { "kind": "token" | "session" } }
// }
//
// token 不写在这里：`mode-store.ts` 用 Electron safeStorage 加密后存 `tokenEnc`。
// 本文件只做结构校验与 URL 归一，便于 node:test 直接覆盖。
export type DesktopMode = "host" | "client";

export type ClientAuthKind = "token" | "session";

export interface ClientProfile {
  /** 归一后的远程主机根地址（http/https，无尾斜杠、无路径）。 */
  baseUrl: string;
  auth: { kind: "token" } | { kind: "session" };
}

export interface DesktopConfig {
  version: 1;
  mode: DesktopMode;
  client: ClientProfile | null;
}

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  version: 1,
  mode: "host",
  client: null,
};

/**
 * 归一远程主机地址：
 * - 只允许 http/https；
 * - 去掉查询串、hash、尾斜杠与多余路径（Web Host 管理端固定在根路径）；
 * - 拒绝带内嵌凭据的 URL（凭据只从 token/会话通道来）。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (raw === "") throw new Error("主机地址不能为空");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("主机地址格式无效，请输入完整地址（例如 https://flowlet.example.com）");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("主机地址只支持 http:// 或 https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("主机地址不能包含用户名或密码，请使用管理凭据登录");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    const trimmed = url.pathname.replace(/\/+$/, "");
    if (trimmed !== "") {
      throw new Error("主机地址不能带路径，只填写协议 + 域名（+ 端口）");
    }
  }
  return `${url.protocol}//${url.host}`;
}

export function parseDesktopConfig(raw: unknown): DesktopConfig {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_DESKTOP_CONFIG };
  const value = raw as Record<string, unknown>;
  const mode = value.mode === "client" ? "client" : "host";
  const clientRaw = value.client;
  let client: ClientProfile | null = null;
  if (mode === "client" && clientRaw !== null && typeof clientRaw === "object") {
    const candidate = clientRaw as Record<string, unknown>;
    const authRaw = candidate.auth;
    const kind =
      authRaw !== null && typeof authRaw === "object" && (authRaw as Record<string, unknown>).kind === "session"
        ? "session"
        : "token";
    try {
      client = {
        baseUrl: normalizeBaseUrl(String(candidate.baseUrl ?? "")),
        auth: { kind },
      };
    } catch {
      // 地址损坏时不让应用起不来：回落到主机模式，由用户重新填写。
      client = null;
    }
  }
  return {
    version: 1,
    mode: client === null ? "host" : mode,
    client,
  };
}

export function serializeDesktopConfig(config: DesktopConfig, tokenEnc?: string | null): string {
  return `${JSON.stringify(
    {
      version: 1,
      mode: config.mode,
      client:
        config.client === null
          ? null
          : {
              baseUrl: config.client.baseUrl,
              auth: config.client.auth,
              ...(tokenEnc !== undefined && tokenEnc !== null ? { tokenEnc } : {}),
            },
    },
    null,
    2,
  )}\n`;
}

/** 远程 API 地址拼接：baseUrl 已归一，path 必须以 `/` 开头。 */
export function remoteUrl(baseUrl: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}
