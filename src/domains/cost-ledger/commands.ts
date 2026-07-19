import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { CostLedgerSourceProbeResult } from "./types";

export const costLedgerCommands = {
  probeSources: (): Promise<CostLedgerSourceProbeResult> =>
    invokeCommand<CostLedgerSourceProbeResult>("probe_cost_ledger_sources").catch((error: unknown) => {
      throw toAppError(error, "cost_ledger_source_probe_failed");
    }),
};
