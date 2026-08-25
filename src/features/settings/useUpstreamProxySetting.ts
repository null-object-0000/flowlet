import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getUpstreamProxyConfig,
  setUpstreamProxyConfig,
} from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

export function useUpstreamProxySetting() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.settings.upstreamProxy(),
    queryFn: getUpstreamProxyConfig,
  });
  const mutation = useMutation({
    mutationFn: setUpstreamProxyConfig,
    onSuccess: (config) => {
      queryClient.setQueryData(queryKeys.settings.upstreamProxy(), config);
    },
  });
  return { query, mutation };
}
