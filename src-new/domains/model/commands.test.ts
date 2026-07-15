import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { modelCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("modelCommands contract", () => {
  it("saves the complete candidate list through save_route_candidates", async () => {
    const routes = [{ id: "route-1", enabled: false }];
    await modelCommands.saveRouteCandidates(routes as never);
    expect(invokeMock).toHaveBeenCalledWith("save_route_candidates", { routes });
  });
});
