import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dataRepairCommands } from "../../domains/data-repair/commands";
import type { DataRepairResults, DataRepairStage, DataRepairState } from "../../domains/data-repair/types";
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

  const refreshAffectedQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSession.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.requestLog.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.usage.all }),
    ]);
  }, [queryClient]);

  const run = useCallback(async () => {
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

      await execute("sessions", dataRepairCommands.repairSessions);
      await execute("capturedUsage", dataRepairCommands.repairCapturedUsage);
      await execute("unknownUsage", dataRepairCommands.repairUnknownUsage);
      await execute("costs", dataRepairCommands.repairCosts);
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

  return { state, run };
}
