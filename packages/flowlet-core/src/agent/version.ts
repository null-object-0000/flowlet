// Agent 最新版本查询（npm registry）。权威实现：`src-tauri/src/core/agent_version.rs`。
//
// 只做「提示」：返回最新版本号与检查时间，不执行下载/升级；单个 Agent 失败
// 独立返回 error，不影响其它 Agent。进程内 15 分钟 TTL 缓存。
import type { JsonRow } from "../types.ts";
import { describeNetworkError, httpJson, type AgentProxySettings, type HttpJsonResponse } from "./http.ts";
import { AGENTS } from "./registry.ts";

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedEntry {
  version: string | null;
  error: string | null;
  checkedAt: number;
  fetchedAt: number;
}

const cache = new Map<string, CachedEntry>();

/** 测试注入点：npm registry 请求实现（默认发真实 HTTPS 请求）。 */
let fetchJson: (url: string, options: Parameters<typeof httpJson>[1]) => Promise<HttpJsonResponse> =
  httpJson;

export function setVersionFetchForTests(
  implementation: ((url: string, options: Parameters<typeof httpJson>[1]) => Promise<HttpJsonResponse>) | null,
): void {
  fetchJson = implementation ?? httpJson;
  cache.clear();
}

/** 清空进程内 TTL 缓存（测试用）。 */
export function clearVersionCache(): void {
  cache.clear();
}

export interface LatestVersionReport {
  agent_id: string;
  package: string;
  latest_version: string | null;
  checked_at: number;
  error: string | null;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** 检查所有受支持 Agent 的最新发布版本（并行，带 TTL 缓存）。 */
export async function checkAgentLatestVersions(
  proxy?: AgentProxySettings | null,
): Promise<{ agents: LatestVersionReport[] }> {
  const agents = await Promise.all(AGENTS.map((agent) => checkOne(agent.id, proxy)));
  return { agents };
}

async function checkOne(agentId: string, proxy?: AgentProxySettings | null): Promise<LatestVersionReport> {
  const agent = AGENTS.find((item) => item.id === agentId);
  if (agent === undefined) {
    return {
      agent_id: agentId,
      package: "",
      latest_version: null,
      checked_at: 0,
      error: `不支持的 Agent：${agentId}`,
    };
  }
  const cached = cache.get(agentId);
  if (cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      agent_id: agentId,
      package: agent.npmPackage,
      latest_version: cached.version,
      checked_at: cached.checkedAt,
      error: cached.error,
    };
  }
  let version: string | null = null;
  let error: string | null = null;
  try {
    version = await fetchLatestVersion(agent.npmPackage, proxy);
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : String(fetchError);
  }
  const checkedAt = unixNow();
  cache.set(agentId, { version, error, checkedAt, fetchedAt: Date.now() });
  return {
    agent_id: agentId,
    package: agent.npmPackage,
    latest_version: version,
    checked_at: checkedAt,
    error,
  };
}

async function fetchLatestVersion(packageName: string, proxy?: AgentProxySettings | null): Promise<string> {
  const url = `https://registry.npmjs.org/${packageName}/latest`;
  let response;
  try {
    response = await fetchJson(url, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      proxy: proxy ?? null,
      headers: {
        accept: "application/json",
        "user-agent": "Flowlet/0.1.0 (agent version check)",
      },
    });
  } catch (error) {
    throw new Error(`版本检查请求失败：${describeNetworkError(error)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`版本源返回 HTTP ${response.status}`);
  }
  if (response.value === null || typeof response.value !== "object" || Array.isArray(response.value)) {
    throw new Error("版本源返回了无效数据");
  }
  const version = (response.value as JsonRow).version;
  if (typeof version !== "string" || version === "") {
    throw new Error("版本源缺少 version 字段");
  }
  return version;
}