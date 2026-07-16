import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAutostartEnabled, setAutostartEnabled } from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

export function useAutostartSetting() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.settings.autostart(), queryFn: getAutostartEnabled });
  const mutation = useMutation({
    mutationFn: setAutostartEnabled,
    onSuccess: (enabled) => queryClient.setQueryData(queryKeys.settings.autostart(), enabled),
  });
  return { query, mutation };
}

