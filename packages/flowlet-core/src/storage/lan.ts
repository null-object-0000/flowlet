// 局域网发现/探测状态的 app_meta 持久化。Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/lan_sync.rs 的三个 app_meta 键：
// - `device_lan_descriptor_v1`：本机对外发布的 LanPeerDescriptor；
// - `device_lan_peers_v1`：已知 peer 的 LanPeerDescriptor 映射（deviceId → descriptor）；
// - `mobile_lan_probe_cache_v1`：最近一次探测结果缓存（移动端读取）。
// 这里全部是纯函数（db 直接读写 app_meta），供桌面命令层通过
// `ctx.storage.withDatabase((db) => ...)` 调用。
import type { DatabaseSync } from "node:sqlite";

import type { LanPeerDescriptor } from "../device/bundle.ts";
import { getAppMeta, setAppMeta } from "./config.ts";

export const LAN_DESCRIPTOR_KEY = "device_lan_descriptor_v1";
export const LAN_PEERS_KEY = "device_lan_peers_v1";
export const LAN_PROBE_CACHE_KEY = "mobile_lan_probe_cache_v1";

export interface LanProbeResult {
  deviceId: string;
  lanPublished: boolean;
  reachable: boolean;
  latencyMs: number | null;
  protocolVersion: number | null;
  errorKind: "unreachable" | "unauthorized" | "outdated" | "invalid" | null;
  error: string | null;
}

export interface LanProbeCache {
  probedAt: string;
  probes: LanProbeResult[];
}

function readJson(db: DatabaseSync, key: string): unknown {
  const raw = getAppMeta(db, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Rust `current_descriptor` 的持久化半边：读取描述符。 */
export function loadLanDescriptor(db: DatabaseSync): LanPeerDescriptor | null {
  const value = readJson(db, LAN_DESCRIPTOR_KEY);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LanPeerDescriptor;
}

export function saveLanDescriptor(db: DatabaseSync, descriptor: LanPeerDescriptor): void {
  setAppMeta(db, LAN_DESCRIPTOR_KEY, JSON.stringify(descriptor));
}

/** Rust `load_peer_registry`：app_meta 中直接存 deviceId → descriptor 的 JSON 对象。 */
export function loadPeerRegistry(db: DatabaseSync): Record<string, LanPeerDescriptor> {
  const value = readJson(db, LAN_PEERS_KEY);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const registry: Record<string, LanPeerDescriptor> = {};
  for (const [deviceId, descriptor] of Object.entries(value as Record<string, unknown>)) {
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      continue;
    }
    registry[deviceId] = descriptor as unknown as LanPeerDescriptor;
  }
  return registry;
}

export function savePeerRegistry(
  db: DatabaseSync,
  registry: Record<string, LanPeerDescriptor>,
): void {
  setAppMeta(db, LAN_PEERS_KEY, JSON.stringify(registry));
}

/** Rust `remember_peer`：快照里若带 lanPeer，就写入 peer registry。 */
export function rememberPeer(
  db: DatabaseSync,
  deviceId: string,
  descriptor: LanPeerDescriptor | null | undefined,
): void {
  if (descriptor === null || descriptor === undefined) return;
  const registry = loadPeerRegistry(db);
  registry[deviceId] = descriptor;
  savePeerRegistry(db, registry);
}

export function loadProbeCache(db: DatabaseSync): LanProbeCache | null {
  const value = readJson(db, LAN_PROBE_CACHE_KEY);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const cache = value as Partial<LanProbeCache>;
  if (typeof cache.probedAt !== "string" || !Array.isArray(cache.probes)) return null;
  return { probedAt: cache.probedAt, probes: cache.probes as LanProbeResult[] };
}

export function saveProbeCache(db: DatabaseSync, cache: LanProbeCache): void {
  setAppMeta(db, LAN_PROBE_CACHE_KEY, JSON.stringify(cache));
}