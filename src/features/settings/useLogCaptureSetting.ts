import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLogCaptureConfig, setLogCaptureConfig } from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

export function useLogCaptureSetting() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.settings.logCapture(), queryFn: getLogCaptureConfig });
  const mutation = useMutation({
    mutationFn: setLogCaptureConfig,
    onSuccess: (voidResult, config) => {
      queryClient.setQueryData(queryKeys.settings.logCapture(), config);
    },
  });
  return { query, mutation };
}
