import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyClaudeCodeGlobalConfig,
  applyOpenCodeGlobalConfig,
  detectClaudeCodeEnvironment,
  inspectClaudeCodeGlobalConfig,
  inspectOpenCodeGlobalConfig,
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
