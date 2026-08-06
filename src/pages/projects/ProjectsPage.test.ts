import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { ProjectTask } from "../../domains/project/types";
import { buildDoneTaskTree, computeTaskBoardColumns, filterProjectTasks, taskLastExecutionInterrupted } from "./ProjectsPage";

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    projectId: "project-1",
    title: "实现任务看板搜索",
    description: "在任务看板页添加搜索框",
    status: "draft",
    taskType: "code",
    agentProfile: "Claude Code",
    priority: "p2",
    baseTaskId: null,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeTaskBoardColumns", () => {
  it("keeps 3 columns on the default 1200px window with sidebar", () => {
    // 1200 窗口 - 188 侧边栏 - 2×16 页边距 = 980px 内容宽度，恰好 3 列。
    expect(computeTaskBoardColumns(980)).toBe(3);
  });

  it("shows a 4th column once the container can fit it", () => {
    // 4 列最小需要 4×240 + 3×12 = 996px。
    expect(computeTaskBoardColumns(996)).toBe(4);
    expect(computeTaskBoardColumns(995)).toBe(3);
  });

  it("never drops below 3 columns when space is tight", () => {
    expect(computeTaskBoardColumns(600)).toBe(3);
    expect(computeTaskBoardColumns(0)).toBe(3);
  });

  it("caps at 4 columns on very wide windows", () => {
    expect(computeTaskBoardColumns(2000)).toBe(4);
  });
});

describe("filterProjectTasks", () => {
  const tasks = [
    makeTask({ title: "修复登录超时问题", description: "定位并修复登录超时", status: "submitted" }),
    makeTask({ title: "添加用量统计图表", description: "在概览页增加用量图表", status: "in_progress", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    makeTask({ title: "只读分析接口性能", taskType: "readonly", agentProfile: "OpenCode", priority: "p0", status: "review" }),
  ];

  it("returns all tasks for an empty keyword", () => {
    expect(filterProjectTasks(tasks, "")).toEqual(tasks);
    expect(filterProjectTasks(tasks, "   ")).toEqual(tasks);
  });

  it("matches title and description case-insensitively", () => {
    expect(filterProjectTasks(tasks, "登录超时").map((task) => task.title)).toEqual(["修复登录超时问题"]);
    expect(filterProjectTasks(tasks, "用量图表").map((task) => task.title)).toEqual(["添加用量统计图表"]);
  });

  it("matches task id fragments", () => {
    expect(filterProjectTasks(tasks, "bbbb-cccc").map((task) => task.title)).toEqual(["添加用量统计图表"]);
  });

  it("matches type value, Chinese type label, agent and priority", () => {
    expect(filterProjectTasks(tasks, "readonly").map((task) => task.title)).toEqual(["只读分析接口性能"]);
    expect(filterProjectTasks(tasks, "只读分析").map((task) => task.title)).toEqual(["只读分析接口性能"]);
    expect(filterProjectTasks(tasks, "opencode").map((task) => task.title)).toEqual(["只读分析接口性能"]);
    expect(filterProjectTasks(tasks, "p0").map((task) => task.title)).toEqual(["只读分析接口性能"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterProjectTasks(tasks, "不存在的关键词")).toEqual([]);
  });
});

describe("buildDoneTaskTree", () => {
  const parent = makeTask({ title: "父任务", status: "done" });
  const child = makeTask({
    title: "子任务",
    status: "done",
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    baseTaskId: parent.id,
  });
  const orphan = makeTask({
    title: "孤儿子任务",
    status: "done",
    id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    baseTaskId: "missing-parent-id",
  });
  const standalone = makeTask({
    title: "独立任务",
    status: "done",
    id: "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa",
  });

  it("groups a child under its done parent and leaves roots independent", () => {
    const { childrenMap, roots } = buildDoneTaskTree([standalone, child, parent]);
    expect(roots.map((task) => task.id)).toEqual([standalone.id, parent.id]);
    expect(childrenMap.get(parent.id)?.map((task) => task.id)).toEqual([child.id]);
  });

  it("treats a child whose parent is absent as a root task", () => {
    const { childrenMap, roots } = buildDoneTaskTree([orphan, standalone]);
    expect(roots.map((task) => task.id)).toEqual([orphan.id, standalone.id]);
    expect(childrenMap.size).toBe(0);
  });

  it("returns empty roots for an empty list", () => {
    const { childrenMap, roots } = buildDoneTaskTree([]);
    expect(roots).toEqual([]);
    expect(childrenMap.size).toBe(0);
  });

  it("supports multi-level nesting through recursion", () => {
    const grandchild = makeTask({
      title: "孙任务",
      status: "done",
      id: "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb",
      baseTaskId: child.id,
    });
    const { childrenMap, roots } = buildDoneTaskTree([grandchild, child, parent]);
    expect(roots.map((task) => task.id)).toEqual([parent.id]);
    expect(childrenMap.get(parent.id)?.map((task) => task.id)).toEqual([child.id]);
    expect(childrenMap.get(child.id)?.map((task) => task.id)).toEqual([grandchild.id]);
  });
});

describe("taskLastExecutionInterrupted", () => {
  const openRunHistory = (interrupted?: boolean) => JSON.stringify([{
    jobId: "job-1",
    startedAt: "2026-08-06T00:00:00.000Z",
    submittedAt: null,
    finishedAt: interrupted ? "2026-08-06T00:10:00.000Z" : null,
    waitingMs: 0,
    executionMs: null,
    rejected: false,
    rejectionReason: null,
    rejectedAt: null,
    ...(interrupted != null ? { interrupted } : {}),
  }]);

  it("flags a task whose latest run was interrupted by an app restart", () => {
    const task = makeTask({ status: "submitted", executionHistory: openRunHistory(true) });
    expect(taskLastExecutionInterrupted(task)).toBe(true);
  });

  it("is false for a task whose latest run finished normally", () => {
    const task = makeTask({ status: "submitted", executionHistory: openRunHistory(false) });
    expect(taskLastExecutionInterrupted(task)).toBe(false);
  });

  it("is false when there is no execution history", () => {
    expect(taskLastExecutionInterrupted(makeTask({ status: "submitted" }))).toBe(false);
  });
});
