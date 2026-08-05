import { describe, expect, it } from "vitest";
import { SUBMIT_GRACE_MS, isTaskWithinSubmitGrace } from "./useProjects";

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
