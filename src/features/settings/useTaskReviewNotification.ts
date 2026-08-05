import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTaskReviewNotificationEnabled,
  setTaskReviewNotificationEnabled,
} from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

/** 任务执行完成进入待审核时的系统通知开关。默认开启。 */
export function useTaskReviewNotification() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.settings.taskReviewNotification(),
    queryFn: getTaskReviewNotificationEnabled,
  });
  const mutation = useMutation({
    mutationFn: setTaskReviewNotificationEnabled,
    onSuccess: (enabled) =>
      queryClient.setQueryData(queryKeys.settings.taskReviewNotification(), enabled),
  });
  return { query, mutation };
}