import { useMutation, useQueryClient } from "@tanstack/react-query";
import { proxyCommands } from "../../domains/proxy/commands";
import { compactDatabase } from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";
import { suspendProxyAutoStart } from "../proxy-lifecycle/proxyAutoStartSuspension";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useStorageMaintenance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const status = await proxyCommands.status();
      const releaseAutoStart = suspendProxyAutoStart();
      let proxyPaused = false;
      let operationError: unknown;
      let result: Awaited<ReturnType<typeof compactDatabase>> | undefined;

      try {
        if (status.running) {
          await proxyCommands.stop();
          proxyPaused = true;
        }
        result = await compactDatabase();
      } catch (error) {
        operationError = error;
      }

      let restartError: unknown;
      if (status.running && proxyPaused) {
        try {
          await proxyCommands.start();
        } catch (error) {
          restartError = error;
        }
      }
      releaseAutoStart();

      if (operationError && restartError) {
        throw new Error(`${errorMessage(operationError)}；恢复代理失败：${errorMessage(restartError)}`);
      }
      if (operationError) throw operationError;
      if (restartError) throw new Error(`数据库优化完成，但恢复代理失败：${errorMessage(restartError)}`);
      if (!result) throw new Error("数据库优化未返回结果");
      return result;
    },
    onSettled: () => {
      void queryClient.refetchQueries({ queryKey: queryKeys.proxy.status(), exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.storageUsage(), exact: true });
    },
  });
}
