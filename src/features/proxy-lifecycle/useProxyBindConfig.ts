import { useQuery } from "@tanstack/react-query";
import { proxyCommands } from "../../domains/proxy/commands";
import { queryKeys } from "../../shared/query-keys";

export function useProxyBindConfig() {
  return useQuery({
    queryKey: queryKeys.proxy.bindConfig(),
    queryFn: () => proxyCommands.bindConfig(),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
