import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { A2aStore, type A2aCall } from "../storage/a2a.ts";

it("filters polls before limiting and separates original responses from latest task observations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new A2aStore(db);
    const call: A2aCall = {
      id: "send",
      agentId: "a",
      keyId: "key",
      method: "SendMessage",
      startedAt: "2026-11-16T00:00:00Z",
      durationMs: 12,
      httpStatus: 200,
      taskId: "task",
      contextId: "ctx",
      state: "TASK_STATE_SUBMITTED",
      error: null,
      requestBody: null,
      responseBody: null,
    };
    store.record(call);
    for (let i = 1; i <= 150; i++)
      store.record({
        ...call,
        id: `poll-${i}`,
        method: "GetTask",
        startedAt: new Date(Date.UTC(2026, 10, 16, 0, 0, i)).toISOString(),
        state: i === 150 ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
      });
    store.record({
      ...call,
      id: "error",
      method: "GetTask",
      startedAt: "2026-11-16T01:00:00Z",
      error: "JSON-RPC failure",
    });
    store.record({
      ...call,
      id: "other-agent",
      agentId: "other",
      startedAt: "2026-11-16T02:00:00Z",
      state: "TASK_STATE_FAILED",
    });
    const activity = store.calls("a", true);
    assert.equal(activity.length, 2);
    const send = activity.find((row) => row.id === "send")!;
    assert.equal(send.state, "TASK_STATE_SUBMITTED");
    assert.equal(send.latestTaskState, "TASK_STATE_COMPLETED");
    assert.equal(activity[0].id, "error");
    assert.equal(store.calls("a").length, 100);
  } finally {
    db.close();
  }
});
