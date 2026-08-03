import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (...args: unknown[]) => invokeMock(...args),
  toAppError: (error: unknown) => error,
}));

import { projectCommands } from "./commands";

describe("projectCommands", () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

  it("uses the typed project command boundary", async () => {
    const project = { id: "p1", name: "Flowlet", directoryPath: "D:\\work\\flowlet", createdAt: "now", updatedAt: "now" };
    await projectCommands.save(project);
    expect(invokeMock).toHaveBeenCalledWith("save_project", { project });
  });

  it("scopes task deletion to its project", async () => {
    await projectCommands.deleteTask("p1", "t1");
    expect(invokeMock).toHaveBeenCalledWith("delete_project_task", { projectId: "p1", taskId: "t1" });
  });
});
