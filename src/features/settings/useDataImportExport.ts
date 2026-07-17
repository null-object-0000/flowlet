import { useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { exportAllData, importAllData } from "../../domains/settings/commands";

export interface ExportProgress {
  stage: string;
  message: string;
}

export function useDataExport() {
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const path = await save({
        defaultPath: `flowlet-backup-${new Date().toISOString().slice(0, 10)}.flowlet`,
        filters: [{ name: "Flowlet Backup", extensions: ["flowlet"] }],
      });
      if (!path) throw new Error("CANCELLED");

      const unlisten = await listen<ExportProgress>("export-progress", (event) => {
        setProgress(event.payload);
      });

      try {
        await exportAllData(path);
      } finally {
        unlisten();
        setProgress(null);
      }
    },
  });

  return { ...mutation, progress };
}

export function useDataImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const path = await open({
        filters: [{ name: "Flowlet Backup", extensions: ["flowlet"] }],
        multiple: false,
      });
      if (!path) throw new Error("CANCELLED");
      await importAllData(path as string);
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}
