import { useMutation, useQueryClient } from "@tanstack/react-query";
import { proxyCommands } from "../../domains/proxy/commands";
import { queryKeys } from "../../shared/query-keys";

/**
 * Proxy lifecycle mutations. Each mutates only the proxy status query —
 * never a global refresh. On success we refetch status; on failure we also
 * refetch status so the UI reflects reality (start can be rejected as
 * already-running, etc.).
 */
export function useProxyActions() {
  const qc = useQueryClient();

  const refetchStatus = () => qc.refetchQueries({ queryKey: queryKeys.proxy.status(), exact: true });

  const wrap = <T,>(mut: ReturnType<typeof useMutation<void, unknown, T>>) => ({
    ...mut,
  });

  const start = useMutation({
    mutationFn: () => proxyCommands.start(),
    onSuccess: refetchStatus,
    onError: () => {
      // Always reconcile with the real state even on failure.
      void refetchStatus();
    },
  });

  const restart = useMutation({
    mutationFn: () => proxyCommands.restart(),
    onSuccess: refetchStatus,
    onError: () => void refetchStatus(),
  });

  return {
    start: wrap(start),
    restart: wrap(restart),
    /** Derived convenience flags for button state. */
  };
}
