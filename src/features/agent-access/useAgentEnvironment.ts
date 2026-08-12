import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyAgentGlobalConfig,
  authorizeCodexAccount,
  checkAgentLatestVersions,
  detectAgentEnvironment,
  inspectAgentGlobalConfig,
  listCachedCodexAccounts,
  queryCodexAccount,
  restoreAgentGlobalConfig,
} from "../../domains/agent/commands";
import type { AgentGlobalConfigOptions, CodexAccountsReport } from "../../domains/agent/types";
import { AGENT_PLUGINS, type AgentPluginId } from "../../domains/pluginRegistry";
import { queryKeys } from "../../shared/query-keys";

export function useAgentEnvironments() {
  const queries = useQueries({
    queries: AGENT_PLUGINS.map((agent) => ({
      queryKey: queryKeys.agent.environment(agent.id),
      queryFn: () => detectAgentEnvironment(agent.id),
      staleTime: 60_000,
      retry: 1,
    })),
  });
  return new Map(AGENT_PLUGINS.map((agent, index) => [agent.id, queries[index]]));
}

// Agent 最新版本提示：概览页卡片 Badge dot 与接入抽屉共用。npm 版本不会高频变化，
// 30 分钟 staleTime + Rust 端 15 分钟进程内 TTL 缓存，避免重复请求 registry。
export function useAgentLatestVersions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.agent.latestVersions(),
    queryFn: checkAgentLatestVersions,
    enabled,
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

// Codex 账号与用量现在由 CodexAccountAutoSync 周期性后台同步刷新本地快照，
// 因此打开 Agent 弹窗时只读取缓存快照，不再主动发起网络请求；只有用户手动点
// "刷新用量"时，才通过 useCodexAccountRefreshOne 触发当前账号的实时网络刷新。
export function useCodexAccounts(enabled = true) {
  const queryKey = queryKeys.agent.codexAccount();
  return useQuery({
    queryKey,
    queryFn: listCachedCodexAccounts,
    enabled,
    staleTime: 0,
    retry: false,
    // 概览页把 Codex 伪装为渠道账号展示，需要定期从缓存快照中读取最新数据。
    // CodexAccountAutoSync 每 5 分钟写一次新快照，这里每 30 秒读一次。
    refetchInterval: 30_000,
  });
}

// 单账号刷新：只更新缓存中对应 account_id 的报告，保留其他账号的快照。
export function useCodexAccountRefreshOne() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.codexAccount();
  return useMutation({
    mutationFn: queryCodexAccount,
    onSuccess: (report) => {
      const current = queryClient.getQueryData<CodexAccountsReport>(queryKey);
      const accounts = current?.accounts ?? [];
      const next = [...accounts.filter((item) => item.account_id !== report.account_id), report];
      queryClient.setQueryData<CodexAccountsReport>(queryKey, { accounts: next });
    },
  });
}

export function useCodexAccountAuthorization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authorizeCodexAccount,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agent.codexAccount() }),
  });
}

export function useAgentGlobalConfig(agentId: AgentPluginId | null) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.globalConfig(agentId ?? "inactive");
  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!agentId) return Promise.reject(new Error("未选择 Agent"));
      return inspectAgentGlobalConfig(agentId);
    },
    enabled: agentId != null,
    staleTime: 30_000,
    retry: 1,
  });
  const apply = useMutation({
    mutationFn: (options?: AgentGlobalConfigOptions) => {
      if (!agentId) return Promise.reject(new Error("未选择 Agent"));
      return applyAgentGlobalConfig(agentId, options);
    },
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });
  const restore = useMutation({
    mutationFn: () => {
      if (!agentId) return Promise.reject(new Error("未选择 Agent"));
      return restoreAgentGlobalConfig(agentId);
    },
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });

  return { query, apply, restore };
}
