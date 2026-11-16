import { describe, expect, it } from "vitest";
import { callOutcome } from "./presentation";
import type { A2aCall } from "./types";
describe("Gateway request outcomes", () => {
  it("does not confuse task state with transport success", () => {
    const call = {
      httpStatus: 200,
      error: null,
      state: "TASK_STATE_WORKING",
    } as A2aCall;
    expect(callOutcome(call).label).toBe("请求成功");
    expect(callOutcome({ ...call, error: "JSON-RPC failure" }).label).toBe(
      "请求失败",
    );
    expect(callOutcome({ ...call, finishedAt: null }).label).toBe("请求中");
    expect(callOutcome({ ...call, httpStatus: null }).label).toBe("结果未知");
  });
});
