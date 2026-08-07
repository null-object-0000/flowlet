import { describe, expect, it } from "vitest";
import { groupMobileProjects } from "./groupMobileProjects";
import type { SharedDeviceProject } from "../domains/device-sync/types";

function project(overrides: Partial<SharedDeviceProject>): SharedDeviceProject {
  return {
    deviceId: "device-1",
    deviceDisplayName: "Office PC",
    devicePlatform: "windows",
    projectId: "project-1",
    projectName: "flowlet",
    hasLocalBinding: true,
    updatedAt: "2026-07-30T02:00:00Z",
    tasks: [],
    ...overrides,
  };
}

describe("groupMobileProjects", () => {
  it("合并同 workspaceProjectId 的多设备快照并去重任务（保留最新）", () => {
    const groups = groupMobileProjects([
      project({
        deviceId: "device-1",
        deviceDisplayName: "Office PC",
        updatedAt: "2026-07-30T01:00:00Z",
        tasks: [
          { id: "task-1", title: "旧标题", status: "draft", priority: "p1", updatedAt: "2026-07-30T01:00:00Z" },
        ],
      }),
      project({
        deviceId: "device-2",
        deviceDisplayName: "Home PC",
        updatedAt: "2026-07-30T03:00:00Z",
        tasks: [
          { id: "task-1", title: "新标题", status: "submitted", priority: "p1", updatedAt: "2026-07-30T02:00:00Z" },
          { id: "task-2", title: "只有设备二有", status: "done", priority: "p2", updatedAt: "2026-07-30T02:30:00Z" },
        ],
      }),
    ]);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.devices).toHaveLength(2);
    expect(group.updatedAt).toBe("2026-07-30T03:00:00Z");
    // 任务按 id 去重：task-1 保留更新时间最新的「新标题」，并归属其来源设备。
    expect(group.tasks).toHaveLength(2);
    expect(group.tasks.map((item) => item.task.id).sort()).toEqual(["task-1", "task-2"]);
    expect(group.tasks.find((item) => item.task.id === "task-1")?.task.title).toBe("新标题");
    expect(group.tasks.find((item) => item.task.id === "task-1")?.project.deviceId).toBe("device-2");
  });

  it("同名但不同 projectId 的旧数据按名称合并", () => {
    const groups = groupMobileProjects([
      project({ deviceId: "device-1", projectId: "project-a", projectName: "blog" }),
      project({ deviceId: "device-2", projectId: "project-b", projectName: "blog" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].devices).toHaveLength(2);
    expect(groups[0].projectName).toBe("blog");
  });

  it("不同项目保持独立，并按最近更新倒序排列", () => {
    const groups = groupMobileProjects([
      project({ projectId: "project-old", projectName: "旧项目", updatedAt: "2026-07-30T01:00:00Z" }),
      project({ projectId: "project-new", projectName: "新项目", updatedAt: "2026-07-30T04:00:00Z" }),
    ]);

    expect(groups.map((group) => group.projectName)).toEqual(["新项目", "旧项目"]);
  });

  it("组内任务按更新时间倒序排列", () => {
    const groups = groupMobileProjects([
      project({
        tasks: [
          { id: "task-1", title: "较早", status: "submitted", priority: "p1", updatedAt: "2026-07-30T01:00:00Z" },
          { id: "task-2", title: "较新", status: "done", priority: "p2", updatedAt: "2026-07-30T02:00:00Z" },
        ],
      }),
    ]);

    expect(groups[0].tasks.map((item) => item.task.id)).toEqual(["task-2", "task-1"]);
  });
});
