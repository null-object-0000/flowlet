import { useQuery } from "@tanstack/react-query";
import { proxyCommands } from "../../domains/proxy/commands";
import { queryKeys } from "../../shared/query-keys";

/** Query the real proxy runtime status. */
export function useProxyStatus() {
  return useQuery({
    queryKey: queryKeys.proxy.status(),
    queryFn: () => proxyCommands.status(),
    // The loopback Node Host stays reachable even when the OS reports offline.
    networkMode: "always",
    refetchOnWindowFocus: false,
    // Match the legacy overview: reconcile native proxy state every 3 seconds.
    refetchInterval: 3_000,
    retry: false,
  });
}
