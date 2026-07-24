import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dataRepairCommands } from "../../domains/data-repair/commands";
import type { DataRepairResults, DataRepairStage, DataRepairState, DataRepairTimeRange } from "../../domains/data-repair/types";
import { queryKeys } from "../../shared/query-keys";

const stages: DataRepairStage[] = ["sessions", "capturedUsage", "unknownUsage", "costs"];

const initialState: DataRepairState = {
  status: "idle",
  currentStage: null,
  completedStages: [],
  percent: 0,
  results: {},
  error: null,
};

export function useDataRepair() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DataRepairState>(initialState);
  const runningRef = useRef(false);

  // 分批、错峰失效修复后受影响的查询，避免一次性失效触发大量并发 refetch
  // 造成前端在修复完成后再次卡顿。
  const refreshAffectedQueries = useCallback(async () => {
    const batches = [
      [queryKeys.agentSession.all, queryKeys.requestLog.all],
      [queryKeys.usage.all],
      [queryKeys.settings.storageUsage()],
    ];
    for (const batch of batches) {
      await Promise.all(batch.map((key) => queryClient.invalidateQueries({ queryKey: key })));
      // 每批之间让出事件循环，给请求写入端留出落库窗口，同时让前端渐进刷新。
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, [queryClient]);

  const reset = useCallback(() => {
    if (!runningRef.current) setState(initialState);
  }, []);

  const run = useCallback(async (timeRange: DataRepairTimeRange) => {
    if (runningRef.current) return;
    runningRef.current = true;
    let completedStages: DataRepairStage[] = [];
    let results: DataRepairResults = {};
    setState({ ...initialState, status: "running", currentStage: stages[0] });

    try {
      const execute = async <T,>(stage: DataRepairStage, command: () => Promise<T>) => {
        setState((current) => ({ ...current, currentStage: stage }));
        const result = await command();
        completedStages = [...completedStages, stage];
        results = { ...results, [stage === "sessions" ? "sessions" : stage]: result };
        setState({
          status: "running",
          currentStage: stages[completedStages.length] ?? null,
          completedStages,
          percent: completedStages.length / stages.length * 100,
          results,
          error: null,
        });
        return result;
      };

      await execute("sessions", () => dataRepairCommands.repairSessions(timeRange));
      await execute("capturedUsage", () => dataRepairCommands.repairCapturedUsage(timeRange));
      await execute("unknownUsage", () => dataRepairCommands.repairUnknownUsage(timeRange));
      await execute("costs", () => dataRepairCommands.repairCosts(timeRange));
      setState({ status: "success", currentStage: null, completedStages, percent: 100, results, error: null });
      await refreshAffectedQueries();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({
        status: "error",
        currentStage: stages[completedStages.length] ?? null,
        completedStages,
        percent: completedStages.length / stages.length * 100,
        results,
        error: message,
      });
      await refreshAffectedQueries();
      throw error;
    } finally {
      runningRef.current = false;
    }
  }, [refreshAffectedQueries]);

  return { state, run, reset };
}
