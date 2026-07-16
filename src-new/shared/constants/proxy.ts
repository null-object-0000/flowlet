/** Proxy runtime constants shared across domains (single source of truth). */

/** Default local proxy port. Mirrors Rust core::proxy::DEFAULT_BIND_ADDR. */
export const DEFAULT_PROXY_PORT = 18640;

/** Default local proxy bind host. */
export const DEFAULT_PROXY_HOST = "127.0.0.1";

/** Default bind address string. */
export const DEFAULT_BIND_ADDR = `${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`;

/** Default client token placeholder shown until real config loads.
 *  Matches Rust ProxyBindConfig::default_client_token(). */
export const DEFAULT_CLIENT_TOKEN = "flowlet-local-token";
