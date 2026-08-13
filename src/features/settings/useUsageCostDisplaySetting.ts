import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getUsageCostDisplayConfig,
  setUsageCostDisplayConfig,
} from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

export function useUsageCostDisplaySetting() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.settings.usageCostDisplay(),
    queryFn: getUsageCostDisplayConfig,
  });
  const mutation = useMutation({
    mutationFn: setUsageCostDisplayConfig,
    onSuccess: (config) => {
      queryClient.setQueryData(queryKeys.settings.usageCostDisplay(), config);
    },
  });
  return { query, mutation };
}
