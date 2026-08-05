import { describe, expect, it } from "vitest";
import { taskExecutionHistory, taskTotalExecutionDuration, taskTotalWaitingDuration, taskWaitingDuration } from "./types";

describe("taskExecutionHistory", () => {
  it("parses the recorded execution history when present", () => {
    const history = JSON.stringify([
      { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", submittedAt: "2026-08-04T19:50:00.000Z", finishedAt: "2026-08-04T20:30:00.000Z", waitingMs: 600000, executionMs: 1800000, rejected: true, rejectionReason: "不符合预期", rejectedAt: "2026-08-04T21:00:00.000Z" },
    ]);
    const records = taskExecutionHistory({ executionHistory: history, lastJobId: "job-2" });
    expect(records).toHaveLength(1);
    expect(records[0].jobId).toBe("job-1");
    expect(records[0].rejected).toBe(true);
  });

  it("falls back to the latest job when history is missing", () => {
    const records = taskExecutionHistory({ executionHistory: null, lastJobId: "job-9" });
    expect(records).toHaveLength(1);
    expect(records[0].jobId).toBe("job-9");
    expect(records[0].rejected).toBe(false);
    expect(records[0].rejectionReason).toBeNull();
    expect(records[0].finishedAt).toBeNull();
  });

  it("returns empty when neither history nor latest job exists", () => {
    expect(taskExecutionHistory({ executionHistory: null, lastJobId: null })).toEqual([]);
    expect(taskExecutionHistory({ executionHistory: "not-json", lastJobId: null })).toEqual([]);
  });
});

describe("taskTotalExecutionDuration", () => {
  const task = (history: unknown) => ({ executionHistory: JSON.stringify(history), lastJobId: "job-2" });

  it("prefers the recorded executionMs of each finished round", () => {
    const duration = taskTotalExecutionDuration(
      task([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: "2026-08-04T20:30:00.000Z", waitingMs: 0, executionMs: 1800000, rejected: false, rejectionReason: null, rejectedAt: null },
        { jobId: "job-2", startedAt: "2026-08-04T21:00:00.000Z", finishedAt: "2026-08-04T21:10:00.000Z", waitingMs: 0, executionMs: 600000, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      null,
      Date.parse("2026-08-04T22:00:00.000Z"),
    );
    // 30 分钟 + 10 分钟 = 40 分钟 = 2_400_000 ms
    expect(duration).toBe(2_400_000);
  });

  it("counts the running round with the live clock", () => {
    const now = Date.parse("2026-08-04T20:40:00.000Z");
    const duration = taskTotalExecutionDuration(
      task([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: null, waitingMs: 0, executionMs: null, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      "job-1",
      now,
    );
    // 进行中的轮次：now - startedAt = 40 分钟。
    expect(duration).toBe(40 * 60_000);
  });

  it("does not count the review wait into a rejected round's execution time", () => {
    // 被退回轮次：executionMs 是真实执行时长（30min），rejectedAt 远晚于执行结束，
    // 但计算只用 executionMs，绝不用 rejectedAt → 审核等待期不计入执行耗时。
    const duration = taskTotalExecutionDuration(
      task([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: "2026-08-04T20:30:00.000Z", waitingMs: 0, executionMs: 1800000, rejected: true, rejectionReason: "不行", rejectedAt: "2026-08-05T09:00:00.000Z" },
      ]),
      null,
      Date.parse("2026-08-05T10:00:00.000Z"),
    );
    expect(duration).toBe(30 * 60_000);
  });

  it("falls back to finishedAt minus startedAt for legacy rounds without executionMs", () => {
    const duration = taskTotalExecutionDuration(
      task([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: "2026-08-04T20:25:00.000Z", waitingMs: null, executionMs: null, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      null,
      Date.parse("2026-08-04T22:00:00.000Z"),
    );
    expect(duration).toBe(25 * 60_000);
  });

  it("skips rounds whose end is unknowable", () => {
    const duration = taskTotalExecutionDuration(
      task([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: null, waitingMs: null, executionMs: null, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      null,
      Date.parse("2026-08-04T22:00:00.000Z"),
    );
    expect(duration).toBe(0);
  });
});

describe("taskTotalWaitingDuration", () => {
  it("sums each round's waitingMs", () => {
    const waiting = taskTotalWaitingDuration({
      executionHistory: JSON.stringify([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: "2026-08-04T20:30:00.000Z", waitingMs: 600000, executionMs: 1800000, rejected: false, rejectionReason: null, rejectedAt: null },
        { jobId: "job-2", startedAt: "2026-08-04T21:00:00.000Z", finishedAt: "2026-08-04T21:10:00.000Z", waitingMs: 300000, executionMs: 600000, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      lastJobId: "job-2",
    });
    // 10 分钟 + 5 分钟 = 15 分钟。
    expect(waiting).toBe(900_000);
  });

  it("skips legacy rounds without waitingMs", () => {
    const waiting = taskTotalWaitingDuration({
      executionHistory: JSON.stringify([
        { jobId: "job-1", startedAt: "2026-08-04T20:00:00.000Z", finishedAt: "2026-08-04T20:30:00.000Z", waitingMs: null, executionMs: 1800000, rejected: false, rejectionReason: null, rejectedAt: null },
      ]),
      lastJobId: "job-1",
    });
    expect(waiting).toBe(0);
  });
});

describe("taskWaitingDuration", () => {
  const now = Date.parse("2026-08-05T10:00:00.000Z");

  it("measures from the latest submit / reject time", () => {
    // 被退回重新排队：updatedAt 是退回时刻，等待从它重新起算。
    const waiting = taskWaitingDuration(
      { updatedAt: "2026-08-05T09:30:00.000Z" },
      now,
    );
    expect(waiting).toBe(30 * 60_000);
  });

  it("returns null when the timestamp cannot be parsed", () => {
    expect(taskWaitingDuration({ updatedAt: "not-a-date" }, now)).toBeNull();
  });
});