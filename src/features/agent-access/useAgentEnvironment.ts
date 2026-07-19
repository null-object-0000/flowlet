import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  authorizeCodexAccount,
  detectChatGptDesktopEnvironment,
  detectClaudeCodeEnvironment,
  detectOpenCodeEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
  listCachedCodexAccounts,
  queryCodexAccounts,
  restoreClaudeCodeGlobalConfig,
  restoreOpenCodeGlobalConfig,
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

export function useChatGptDesktopEnvironment() {
  return useQuery({
    queryKey: queryKeys.agent.environment("chatgpt-desktop"),
    queryFn: detectChatGptDesktopEnvironment,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useCodexAccounts(enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agent.codexAccount();
  return useQuery({
    queryKey,
    queryFn: async () => {
      const cached = await listCachedCodexAccounts();
      if (cached.accounts.length > 0) {
        queryClient.setQueryData(queryKey, cached);
      }
      return queryCodexAccounts();
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
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
