import { describe, expect, it } from "vitest";
import { DEFAULT_BACKGROUND_JOBS_FILTER, type BackgroundJobRow } from "../../domains/background-task/types";
import { formatJobDuration } from "./taskDuration";

const baseJob: BackgroundJobRow = {
  id: "job-1",
  jobType: "agent-data-sync",
  title: "Agent 数据同步",
  triggerSource: "manual",
  status: "succeeded",
  stage: "完成",
  progressCurrent: 1,
  progressTotal: 1,
  summaryJson: null,
  errorMessage: null,
  createdAt: "2026-07-19 08:00:00",
  startedAt: "2026-07-19 08:00:01",
  finishedAt: "2026-07-19 08:01:31",
  updatedAt: "2026-07-19 08:01:31",
  cancelRequested: false,
};

describe("formatJobDuration", () => {
  it("prefers the measured duration from the task summary", () => {
    expect(formatJobDuration({ ...baseJob, summaryJson: JSON.stringify({ durationMs: 450 }) }, 0, "zh-CN")).toBe("450 ms");
  });

  it("falls back to persisted start and finish timestamps for legacy tasks", () => {
    expect(formatJobDuration(baseJob, 0, "en-US")).toBe("1.5 min");
  });

  it("shows elapsed time for a running task", () => {
    const running = { ...baseJob, status: "running" as const, finishedAt: null, startedAt: "2026-07-19T08:00:00Z" };
    expect(formatJobDuration(running, Date.parse("2026-07-19T08:00:12Z"), "en-US")).toBe("12 s");
  });
});

describe("task log pagination", () => {
  it("uses the same eight-row viewport density as session management", () => {
    expect(DEFAULT_BACKGROUND_JOBS_FILTER.pageSize).toBe(8);
  });
});
