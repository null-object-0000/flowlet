/** Proxy-domain types. Kept free of any React / UI / Semi dependency.
 *  Field names follow the Rust side (ProxyStatus / ProxyBindConfig). */

export type ProxyStatus = {
  running: boolean;
  bind_addr: string;
  /** RFC3339 startup timestamp, null when not running. */
  started_at: string | null;
};

export type ProxyBindConfig = {
  host: string;
  port: number;
  allow_lan: boolean;
  /** Default client token surfaced in the client-access UI. */
  default_client_token?: string | null;
};

export type ProxyRuntimeState = "starting" | "running" | "stopped" | "failed";
