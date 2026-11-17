import assert from "node:assert/strict";
import { it } from "node:test";
import { ManagedAcp, MANAGED } from "./acp-managed.ts";
import type { AcpFrame } from "../../../flowlet-cred/src/acp-remote.ts";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(permission = false) {
  const gate = deferred(),
    started = deferred(),
    asked = deferred();
  let sends = 0,
    cancels = 0;
  let controller: AbortController | undefined,
    execution: Promise<any> | undefined;
  const app = new ManagedAcp(
    async (method, params, signal, emit) => {
      if (method === "initialize")
        return { agentCapabilities: { loadSession: true } };
      if (method === "session/new")
        return { sessionId: "s", configOptions: [] };
      if (method === "session/load" || method === "session/resume")
        return { configOptions: [] };
      if (method === "session/cancel") {
        cancels++;
        gate.resolve();
        return {};
      }
      if (method === "permission/reply") {
        gate.resolve();
        return {};
      }
      if (method === "session/prompt") {
        sends++;
        started.resolve();
        signal.addEventListener("abort", () => gate.resolve(), { once: true });
        await emit({
          type: "update",
          params: {
            sessionId: "s",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "first" },
            },
          },
        });
        if (permission) {
          await emit({
            type: "permission",
            requestId: "p",
            params: {
              sessionId: "s",
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
              toolCall: { toolCallId: "tool", title: "Read" },
            },
          });
          asked.resolve();
        }
        await gate.promise;
        await emit({
          type: "update",
          params: {
            sessionId: "s",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "second" },
            },
          },
        });
        return {
          stopReason: cancels || signal.aborted ? "cancelled" : "end_turn",
        };
      }
      return {};
    },
    10,
    (_id, c, done) => {
      controller = c;
      execution = done;
    },
  );
  const call = (
    m: string,
    p: any = {},
    emit: (f: AcpFrame) => Promise<void> = async () => {},
    signal: AbortSignal = AbortSignal.timeout(5000),
  ) => app.call(m, p, signal, emit);
  const init = async () => {
    await call("initialize");
    await call("session/new");
  };
  return {
    app,
    call,
    init,
    gate,
    started,
    asked,
    stats: () => ({ sends, cancels }),
    execution: () => execution!,
    controller: () => controller!,
  };
}
it("detaches a subscriber while work continues, replays a consistent snapshot and never resends", async () => {
  const f = fixture();
  await f.init();
  const accepted = await f.call("session/start", {
    sessionId: "s",
    prompt: [{ type: "text", text: "run" }],
  });
  const meta: any = (accepted._meta as any)[MANAGED];
  await f.started.promise;
  const abort = new AbortController();
  await assert.rejects(
    f.call(
      "session/subscribe",
      { sessionId: "s", runId: meta.runId, cursor: 0 },
      async () => {
        abort.abort();
      },
      abort.signal,
    ),
  );
  assert.equal(f.controller().signal.aborted, false);
  assert.deepEqual(f.stats(), { sends: 1, cancels: 0 });
  await assert.rejects(f.call("authenticate"), /background work/);
  const history: AcpFrame[] = [];
  const loaded = await f.call(
    "session/load",
    { sessionId: "s" },
    async (frame) => {
      history.push(frame);
    },
  );
  const snap: any = (loaded._meta as any)[MANAGED];
  assert.equal(snap.state, "running");
  assert.equal(history.length, 2);
  const events: AcpFrame[] = [];
  const resumed = f.call(
    "session/subscribe",
    { sessionId: "s", runId: snap.runId, cursor: snap.cursor },
    async (frame) => {
      events.push(frame);
    },
  );
  f.gate.resolve();
  assert.equal((await resumed).stopReason, "end_turn");
  assert.equal(events.length, 1);
  assert.deepEqual(f.stats(), { sends: 1, cancels: 0 });
  await assert.rejects(
    f.call("session/subscribe", {
      sessionId: "s",
      runId: snap.runId,
      cursor: 999,
    }),
    /cursor/,
  );
});
it("keeps a permission request pending while offline and presents it to the next observer", async () => {
  const f = fixture(true);
  await f.init();
  const start = await f.call("session/start", {
    sessionId: "s",
    prompt: [{ type: "text", text: "permission" }],
  });
  await f.asked.promise;
  const meta: any = (start._meta as any)[MANAGED];
  const abort = new AbortController();
  await assert.rejects(
    f.call(
      "session/subscribe",
      { sessionId: "s", runId: meta.runId, cursor: 0 },
      async (frame) => {
        if (frame.type === "permission") abort.abort();
      },
      abort.signal,
    ),
  );
  const status = await f.call("session/status", { sessionId: "s" });
  const current: any = (status._meta as any)[MANAGED];
  assert.equal(current.state, "waiting");
  let seen = false;
  const sub = f.call(
    "session/subscribe",
    { sessionId: "s", runId: meta.runId, cursor: current.cursor },
    async (frame) => {
      if (frame.type === "permission") {
        seen = true;
        await f.call("permission/reply", {
          sessionId: "s",
          requestId: "p",
          outcome: { outcome: "selected", optionId: "yes" },
        });
      }
    },
  );
  await sub;
  assert.equal(seen, true);
  assert.equal(f.stats().sends, 1);
});
it("explicit stop cancels; releasing a session only detaches; shutdown aborts hosted work", async () => {
  const f = fixture();
  await f.init();
  await f.call("session/start", {
    sessionId: "s",
    prompt: [{ type: "text", text: "hold" }],
  });
  await f.started.promise;
  await f.call("session/close", { sessionId: "s" });
  assert.equal(f.stats().cancels, 0);
  await f.call("session/cancel", { sessionId: "s" });
  assert.equal((await f.execution()).stopReason, "cancelled");
  assert.equal(f.stats().cancels, 1);
  const g = fixture();
  await g.init();
  await g.call("session/start", {
    sessionId: "s",
    prompt: [{ type: "text", text: "hold" }],
  });
  g.controller().abort();
  assert.equal((await g.execution()).stopReason, "cancelled");
});
