import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyClaudeCodeGlobalConfig,
  applyCodexGlobalConfig,
  applyOpenCodeGlobalConfig,
  applyPiGlobalConfig,
  authorizeCodexAccount,
  detectChatGptDesktopEnvironment,
  detectClaudeCodeEnvironment,
  detectOpenCodeEnvironment,
  detectPiEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectCodexGlobalConfig,
  inspectOpenCodeGlobalConfig,
  inspectPiGlobalConfig,
  listCachedCodexAccounts,
  queryCodexAccount,
  queryCodexAccounts,
  restoreClaudeCodeGlobalConfig,
  restoreCodexGlobalConfig,
  restoreOpenCodeGlobalConfig,
  restorePiGlobalConfig,
} from "../../domains/agent/commands";
import type { CodexAccountsReport } from "../../domains/agent/types";
import { queryKeys } from "../../shared/query-keys";

export function useClaudeCodeEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("claude-code"),
    queryFn: detectClaudeCodeEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useOpenCodeEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("opencode"),
    queryFn: detectOpenCodeEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}

export function usePiEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("pi"),
    queryFn: detectPiEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useChatGptDesktopEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("chatgpt-desktop"),
    queryFn: detectChatGptDesktopEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}

// Codex 账号与用量现在由 CodexAccountAutoSync 周期性后台同步刷新本地快照，
// 因此打开 Agent 弹窗时只读取缓存快照，不再主动发起网络请求；只有用户手动点
// "刷新用量"时，才通过 useCodexAccountRefresh 触发实时网络刷新。
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

export function useCodexAccountRefresh() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.codexAccount();
  return useMutation({
    mutationFn: queryCodexAccounts,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
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

export function useOpenCodeGlobalConfig(enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.globalConfig("opencode");
  const query = useQuery({
    queryKey,
    queryFn: inspectOpenCodeGlobalConfig,
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
  const apply = useMutation({
    mutationFn: applyOpenCodeGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });
  const restore = useMutation({
    mutationFn: restoreOpenCodeGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });

  return { query, apply, restore };
}

export function usePiGlobalConfig(enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.globalConfig("pi");
  const query = useQuery({
    queryKey,
    queryFn: inspectPiGlobalConfig,
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
  const apply = useMutation({
    mutationFn: applyPiGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });
  const restore = useMutation({
    mutationFn: restorePiGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });

  return { query, apply, restore };
}

export function useClaudeCodeGlobalConfig(enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.globalConfig("claude-code");
  const query = useQuery({
    queryKey,
    queryFn: inspectClaudeCodeGlobalConfig,
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
  const apply = useMutation({
    mutationFn: applyClaudeCodeGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });
  const restore = useMutation({
    mutationFn: restoreClaudeCodeGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });

  return { query, apply, restore };
}

// Codex 全系（CLI / ChatGPT Desktop / VS Code 插件）共享 ~/.codex/config.toml，
// 一键写入只管理 config.toml + auth.json，无额外可选项。
export function useCodexGlobalConfig(enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.globalConfig("codex");
  const query = useQuery({
    queryKey,
    queryFn: inspectCodexGlobalConfig,
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
  const apply = useMutation({
    mutationFn: applyCodexGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });
  const restore = useMutation({
    mutationFn: restoreCodexGlobalConfig,
    onSuccess: (report) => queryClient.setQueryData(queryKey, report),
  });

  return { query, apply, restore };
}
