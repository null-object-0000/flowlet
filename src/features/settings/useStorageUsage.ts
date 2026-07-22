import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useState } from "react";
import { getStorageUsage } from "../../domains/settings/commands";
import type { StorageUsageSummary } from "../../domains/settings/types";
import { queryKeys } from "../../shared/query-keys";

interface StorageUsageProgressEvent {
  scanId: string;
  summary: StorageUsageSummary;
}

const EMPTY_STORAGE_USAGE: StorageUsageSummary = {
  totalBytes: 0,
  databaseBytes: 0,
  reclaimableBytes: 0,
  autoVacuumMode: 0,
  walBytes: 0,
  sharedMemoryBytes: 0,
  configBytes: 0,
  categorizedBytes: 0,
  categories: [
    { key: "configuration", rowCount: 0, allocatedBytes: 0 },
    { key: "requestLogs", rowCount: 0, allocatedBytes: 0 },
    { key: "usage", rowCount: 0, allocatedBytes: 0 },
    { key: "agentSessions", rowCount: 0, allocatedBytes: 0 },
    { key: "backgroundTasks", rowCount: 0, allocatedBytes: 0 },
  ],
};

export function useStorageUsage() {
  const [progress, setProgress] = useState<StorageUsageSummary>(EMPTY_STORAGE_USAGE);
  const query = useQuery({
    queryKey: queryKeys.settings.storageUsage(),
    queryFn: async () => {
      const scanId = crypto.randomUUID();
      setProgress(EMPTY_STORAGE_USAGE);
      const unlisten = await listen<StorageUsageProgressEvent>("storage-usage-progress", (event) => {
        if (event.payload.scanId === scanId) setProgress(event.payload.summary);
      });
      try {
        const summary = await getStorageUsage(scanId);
        setProgress(summary);
        return summary;
      } finally {
        unlisten();
      }
    },
    staleTime: 30_000,
  });
  return { ...query, progress, isCounting: query.isFetching };
}
