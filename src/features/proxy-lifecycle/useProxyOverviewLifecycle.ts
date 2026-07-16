import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import type { ProxyRuntimeState } from "../../domains/proxy/types";
import { toAppError } from "../../platform/tauri/client";
import type { AppError } from "../../shared/errors/AppError";
import { useProxyActions } from "./useProxyActions";
import { useProxyAutoStart } from "./useProxyAutoStart";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

export function useProxyOverviewLifecycle(enabled: boolean) {
  const { t } = useAppPreferences();
  const auto = useProxyAutoStart({ enabled });
  const { start, restart } = useProxyActions();
  const [manualError, setManualError] = useState<AppError | null>(null);
  const running = auto.status.data?.running === true;
  const busy = auto.starting || start.isPending || restart.isPending;
  const error = manualError ?? auto.startError;

  const phase: ProxyRuntimeState = busy
    ? "starting"
    : error
      ? "failed"
      : running
        ? "running"
        : "stopped";

  const runPrimaryAction = async () => {
    if (busy) return;
    setManualError(null);
    auto.clearError();
    try {
      if (running) {
        await restart.mutateAsync();
        Toast.success(t("代理已重启，配置已生效"));
      } else {
        await start.mutateAsync();
        Toast.success(t("本地代理已启动"));
      }
    } catch (actionError) {
      const nextError = toAppError(actionError, running ? "proxy_restart_failed" : "proxy_start_failed");
      setManualError(nextError);
      Toast.error(t(running ? "重启失败：{message}" : "启动失败：{message}", { message: nextError.message }));
    }
  };

  return {
    status: auto.status,
    phase,
    busy,
    error,
    autoStartAttempted: auto.autoStartAttempted,
    runPrimaryAction,
  };
}
