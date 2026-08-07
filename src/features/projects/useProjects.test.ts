import { describe, expect, it } from "vitest";
import type { ProjectTask } from "../../domains/project/types";
import { SUBMIT_GRACE_MS, isTaskWithinSubmitGrace, pickNextClaimableTask } from "./useProjects";

function task(id: string, projectId: string): ProjectTask {
  return {
    id,
    projectId,
    title: `Task ${id}`,
    description: "",
    status: "submitted",
    taskType: "code",
    agentProfile: "Claude Code",
    priority: "p2",
    baseTaskId: null,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    claimedBy: null,
    queueBoostedAt: null,
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
  };
}

describe("pickNextClaimableTask", () => {
  const queued = [
    task("a-1", "project-a"),
    task("a-2", "project-a"),
    task("b-1", "project-b"),
    task("c-1", "project-c"),
  ];

  it("picks the global head when no project is running", () => {
    expect(pickNextClaimableTask(queued, new Set())?.id).toBe("a-1");
  });

  it("skips projects that already have a running task", () => {
    // project-a 正在执行：跳过 a-1 / a-2，从其余项目取队首 b-1。
    expect(pickNextClaimableTask(queued, new Set(["project-a"]) )?.id).toBe("b-1");
  });

  it("allows a different project while another runs (per-project parallelism)", () => {
    // project-b 正在执行：跳过 b-1，但 project-a 空闲，仍可取 a-1。
    expect(pickNextClaimableTask(queued, new Set(["project-b"]))?.id).toBe("a-1");
  });

  it("returns undefined when every queued project is running", () => {
    expect(pickNextClaimableTask(queued, new Set(["project-a", "project-b", "project-c"]))).toBeUndefined();
  });

  it("returns undefined on an empty queue", () => {
    expect(pickNextClaimableTask([], new Set())).toBeUndefined();
  });
});

describe("isTaskWithinSubmitGrace", () => {
  const now = new Date("2026-08-05T10:00:00.000Z").getTime();

  it("treats a task submitted within the grace window as protected", () => {
    // 5 秒前刚提交，仍在后悔窗口内，调度器不应领取。
    const recent = new Date(now - 5_000).toISOString();
    expect(isTaskWithinSubmitGrace(recent, now)).toBe(true);
  });

  it("allows claiming once the grace window has fully passed", () => {
    // 超过窗口 1 秒，可以领取。
    const old = new Date(now - SUBMIT_GRACE_MS - 1_000).toISOString();
    expect(isTaskWithinSubmitGrace(old, now)).toBe(false);
  });

  it("is conservative when the timestamp cannot be parsed", () => {
    // 解析失败视为仍在窗口内，避免刚提交的任务被秒领。
    expect(isTaskWithinSubmitGrace("not-a-date", now)).toBe(true);
  });
});
