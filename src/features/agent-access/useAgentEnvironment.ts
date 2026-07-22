import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  applyPiGlobalConfig,
  authorizeCodexAccount,
  detectChatGptDesktopEnvironment,
  detectClaudeCodeEnvironment,
  detectOpenCodeEnvironment,
  detectPiEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
  inspectPiGlobalConfig,
  listCachedCodexAccounts,
  queryCodexAccounts,
  restoreClaudeCodeGlobalConfig,
  restoreOpenCodeGlobalConfig,
  restorePiGlobalConfig,
} from "../../domains/agent/commands";
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
