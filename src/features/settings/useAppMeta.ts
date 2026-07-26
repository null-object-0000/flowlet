import { useQuery } from "@tanstack/react-query";
import { getAppDataDir, getAppDiagnostics, getAppVersion } from "../../domains/settings/appMeta";
import type { AppMeta } from "../../domains/settings/appMeta";
import { queryKeys } from "../../shared/query-keys";

async function fetchAppMeta(): Promise<AppMeta> {
  const [version, dataDir, diagnostics] = await Promise.all([
    getAppVersion(),
    getAppDataDir(),
    getAppDiagnostics(),
  ]);
  return { version, dataDir, diagnostics };
}

export function useAppMeta() {
  return useQuery({
    queryKey: queryKeys.settings.appMeta("all"),
    queryFn: fetchAppMeta,
    staleTime: Infinity,
    retry: false,
  });
}
