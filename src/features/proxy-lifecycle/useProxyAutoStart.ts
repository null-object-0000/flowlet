import { useEffect, useRef, useState } from "react";
import { useProxyStatus } from "./useProxyStatus";
import { proxyCommands } from "../../domains/proxy/commands";
import type { AppError } from "../../shared/errors/AppError";
import { toAppError } from "../../platform/tauri/client";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../shared/query-keys";
import { isProxyAutoStartSuspended } from "./proxyAutoStartSuspension";

/**
 * Front-end-owned proxy auto-start. Product rules (AGENTS.md §3):
 *   - After the app finishes initialising, if the proxy is not running,
 *     attempt to start it exactly ONCE.
 *   - Never loop on failure; surface the latest start error instead.
 *   - Must be idempotent under React StrictMode (effects fire twice).
 *   - No accounts / no models / no routes must NOT block the start.
 *
 * The Rust `start_proxy` itself is idempotent; this hook only guards the
 * "one attempt per app mount" contract on the UI side.
 */
export function useProxyAutoStart(opts: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const status = useProxyStatus();
  const autoStartAttempted = useRef(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<AppError | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    if (isProxyAutoStartSuspended()) return;
    if (autoStartAttempted.current) return;
    if (status.isLoading || !status.data) return;
    if (status.data.running) return;

    autoStartAttempted.current = true;
    setStarting(true);

    proxyCommands
      .start()
      .then(() => {
        setStartError(null);
      })
      .catch((err: unknown) => {
        setStartError(toAppError(err, "proxy_start_failed"));
      })
      .finally(() => {
        setStarting(false);
        void queryClient.refetchQueries({ queryKey: queryKeys.proxy.status(), exact: true });
      });
  }, [opts.enabled, queryClient, status.isLoading, status.data]);

  return {
    autoStartAttempted: autoStartAttempted.current,
    starting,
    startError,
    isInitialLoading: status.isLoading,
    status,
    clearError: () => setStartError(null),
  };
}
