import { describe, expect, it } from "vitest";
import type { SharedDeviceProject } from "../../domains/device-sync/types";
import type { Project, ProjectTask } from "../../domains/project/types";
import { mergeProjectTasks } from "./mergeProjectTasks";

const project: Project = {
  id: "local-project",
  name: "flowlet",
  directoryPath: "D:/GitHub/flowlet",
  workspaceProjectId: "local-workspace-project",
  workspaceArchived: false,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

function localTask(id: string, title = "本机任务"): ProjectTask {
  return {
    id,
    projectId: project.id,
    title,
    description: "本机完整正文",
    status: "done",
    taskType: "code",
    agentProfile: "Claude Code",
    priority: "p1",
    baseTaskId: null,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    claimedBy: null,
    queueBoostedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
}

function sharedProject(deviceId: string, updatedAt: string): SharedDeviceProject {
  return {
    deviceId,
    deviceDisplayName: deviceId === "company" ? "公司电脑" : "备用电脑",
    devicePlatform: "windows",
    projectId: "different-workspace-project",
    projectName: "Flowlet",
    hasLocalBinding: true,
    updatedAt,
    tasks: [
      { id: "same", title: "远端旧副本", status: "review", priority: "p2", updatedAt },
      { id: "remote", title: `远端任务 ${deviceId}`, status: "review", priority: "p0", updatedAt },
    ],
  };
}

describe("mergeProjectTasks", () => {
  it("按同名项目合并远端快照且本机任务优先", () => {
    const result = mergeProjectTasks(project, [localTask("same")], [sharedProject("company", "2026-08-02T00:00:00Z")]);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.find((task) => task.id === "same")?.title).toBe("本机任务");
    expect(result.tasks.find((task) => task.id === "remote")).toMatchObject({
      projectId: "local-project",
      title: "远端任务 company",
      status: "review",
      taskType: "readonly",
      priority: "p0",
    });
    expect(result.remoteOrigins.get("remote")?.deviceDisplayName).toBe("公司电脑");
    expect(result.remoteOrigins.has("same")).toBe(false);
  });

  it("远端重复 UUID 选择更新时间最新的快照", () => {
    const result = mergeProjectTasks(project, [], [
      sharedProject("company", "2026-08-02T00:00:00Z"),
      sharedProject("spare", "2026-08-03T00:00:00Z"),
    ]);

    expect(result.tasks.find((task) => task.id === "remote")?.title).toBe("远端任务 spare");
    expect(result.remoteOrigins.get("remote")?.deviceDisplayName).toBe("备用电脑");
  });
});
