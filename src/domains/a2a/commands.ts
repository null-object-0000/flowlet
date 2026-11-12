import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { A2aAgent, A2aAgentInput, A2aCall, A2aKey } from "./types";

function call<T>(
  command: string,
  args?: Record<string, unknown>,
  timeout = 15000,
): Promise<T> {
  return invokeCommand<T>(command, args, timeout).catch((error) => {
    throw toAppError(error, "a2a_failed");
  });
}
export const a2aCommands = {
  list: () => call<A2aAgent[]>("list_a2a_agents"),
  inspect: (input: A2aAgentInput) =>
    call<{ card: A2aAgent["card"]; endpoint: string }>("inspect_a2a_agent", {
      input,
    }),
  save: (input: A2aAgentInput) => call<A2aAgent>("save_a2a_agent", { input }),
  remove: (id: string) => call<void>("delete_a2a_agent", { id }),
  keys: () => call<A2aKey[]>("list_a2a_keys"),
  createKey: (name: string, agentIds: string[]) =>
    call<{ id: string; token: string }>("create_a2a_key", { name, agentIds }),
  revokeKey: (id: string) => call<void>("revoke_a2a_key", { id }),
  calls: (agentId?: string) => call<A2aCall[]>("list_a2a_calls", { agentId }),
  invoke: (id: string, rpc: unknown, timeoutSeconds: number) =>
    call<{ status: number; body: unknown }>(
      "invoke_a2a_agent",
      { id, rpc },
      (timeoutSeconds + 5) * 1000,
    ),
};
