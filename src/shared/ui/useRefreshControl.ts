import { useCallback, useState } from "react";

interface UseRefreshControlOptions {
  /** Polling interval in milliseconds while auto-refresh is on. */
  intervalMs: number;
  /** Whether auto-refresh is enabled on first render. Defaults to true. */
  initialAutoRefresh?: boolean;
}

interface UseRefreshControlReturn {
  autoRefresh: boolean;
  setAutoRefresh: (value: boolean | ((prev: boolean) => boolean)) => void;
  toggleAutoRefresh: () => void;
  intervalMs: number;
}

/**
 * Shared auto-refresh state for the four data pages (request logs, agent
 * sessions, task logs, usage costs). The page feeds `autoRefresh` into its
 * TanStack Query `refetchInterval` so toggling it starts/stops polling.
 */
export function useRefreshControl({ intervalMs, initialAutoRefresh = true }: UseRefreshControlOptions): UseRefreshControlReturn {
  const [autoRefresh, setAutoRefresh] = useState(initialAutoRefresh);
  const toggleAutoRefresh = useCallback(() => setAutoRefresh((prev) => !prev), []);
  return { autoRefresh, setAutoRefresh, toggleAutoRefresh, intervalMs };
}
