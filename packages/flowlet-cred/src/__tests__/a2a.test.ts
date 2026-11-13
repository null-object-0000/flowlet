import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import { CredentialStore } from "../store.ts";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const TOKEN = "generic-a2a-test-secret-value";
let http: Server,
  base = "",
  dir = "",
  mode = "normal",
  counter = 0,
  fileReads = 0;
let requests: Array<any> = [];
const tasks = new Map<string, any>();
function child(
  args: string[],
  input?: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, FLOWLET_CRED_DIR: dir };
  for (const key of ["FLOWLET_A2A_TEST_URL", "FLOWLET_A2A_TEST_TOKEN"])
    delete env[key];
  Object.assign(env, extraEnv);
  const selection =
    args.some(
      (arg) =>
        arg === "--prefix" ||
        arg.startsWith("--prefix=") ||
        arg === "--profile" ||
        arg.startsWith("--profile="),
    ) || args[0] === "list"
      ? []
      : ["--profile=TEST"];
  const processHandle = spawn(
    process.execPath,
    [CLI, "a2a", ...args, ...selection],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  processHandle.stdout.on("data", (b) => (stdout += b));
  processHandle.stderr.on("data", (b) => (stderr += b));
  processHandle.stdin.end(input);
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    processHandle.on("error", reject);
    processHandle.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { process: processHandle, result };
}
const run = async (args: string[], input?: string) => child(args, input).result;
function task(text: string, context?: string) {
  const id = "task-" + ++counter;
  const value = {
    id,
    contextId: context ?? "context-" + counter,
    status: { state: "TASK_STATE_SUBMITTED" },
    polls: 0,
    hold: text === "hold",
    fail: text === "fail",
  };
  tasks.set(id, value);
  return value;
}
function publicTask(value: any) {
  const { polls, hold, fail, ...data } = value;
  return data;
}
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition timed out");
}

before(async () => {
  http = createServer(async (req, res) => {
    if (req.url?.includes("/file.txt")) fileReads++;
    if (req.headers.authorization !== "Bearer " + TOKEN) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    assert.equal(req.headers["a2a-version"], "1.0");
    const reply = (id: unknown, result: unknown, error?: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...(error ? { error } : { result }),
        }),
      );
    };
    if (req.method === "GET") {
      if (req.url?.startsWith("/unreachable")) {
        res.writeHead(503);
        res.end("{}");
        return;
      }
      if (req.url?.startsWith("/hanging")) {
        return;
      }
      if (mode === "redirect") {
        res.writeHead(302, { location: base + "/file.txt" });
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: "Independent research agent",
          supportedInterfaces: [
            {
              url:
                (mode === "cross-origin"
                  ? base.replace("127.0.0.1", "localhost")
                  : base) + "/rpc",
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
              tenant: "research",
            },
          ],
          capabilities: { streaming: true, extendedAgentCard: true },
          skills: [
            {
              id: "research",
              name: "Research",
              description:
                mode === "list-secrets"
                  ? "Research " + TOKEN
                  : "Independent research",
              tags: ["analysis"],
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const rpc = JSON.parse(raw);
    requests.push(rpc);
    assert.equal(rpc.params.tenant, "research");
    if (mode === "null-task" && rpc.method === "SendMessage") {
      reply(rpc.id, { task: null });
      return;
    }
    if (mode === "rpc-error") {
      reply(rpc.id, undefined, {
        code: -32007,
        message: "Not configured " + TOKEN,
      });
      return;
    }
    if (
      rpc.method === "SendMessage" &&
      rpc.params.message.parts[0]?.text === "direct"
    ) {
      reply(rpc.id, {
        message: {
          messageId: "agent-message",
          role: "ROLE_AGENT",
          contextId: "direct-context",
          parts: [{ text: "direct answer" }],
        },
      });
      return;
    }
    if (["SendStreamingMessage", "SubscribeToTask"].includes(rpc.method)) {
      const value =
        rpc.method === "SubscribeToTask"
          ? tasks.get(rpc.params.id)
          : task("stream", rpc.params.message.contextId);
      if (!value) {
        reply(rpc.id, undefined, { code: -32001, message: "Task not found" });
        return;
      }
      if (value.status.state === "TASK_STATE_COMPLETED") {
        reply(rpc.id, undefined, {
          code: -32004,
          message: "Cannot subscribe completed",
        });
        return;
      }
      value.status.state = "TASK_STATE_WORKING";
      const events: any[] = [
        {
          task:
            mode === "malformed-stream"
              ? { status: { state: "TASK_STATE_COMPLETED" } }
              : publicTask(value),
        },
      ];
      if (mode !== "dropped")
        events.push(
          {
            artifactUpdate: {
              taskId: value.id,
              contextId: value.contextId,
              artifact: { artifactId: "answer", parts: [{ text: "你好世界" }] },
              append: false,
              lastChunk: true,
            },
          },
          {
            statusUpdate: {
              taskId: value.id,
              contextId: value.contextId,
              status: { state: "TASK_STATE_COMPLETED" },
            },
          },
        );
      res.writeHead(200, { "content-type": "text/event-stream" });
      const body =
        ": keepalive\r\n\r\n" +
        events
          .map(
            (result) =>
              JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }, null, 2)
                .split("\n")
                .map((l) => "data: " + l)
                .join("\r\n") + "\r\n\r\n",
          )
          .join("") +
        ": done\n\n";
      const bytes = Buffer.from(body);
      for (let i = 0; i < bytes.length; i += 7)
        res.write(bytes.subarray(i, i + 7));
      res.end();
      if (mode !== "dropped") value.status.state = "TASK_STATE_COMPLETED";
      return;
    }
    if (rpc.method === "SendMessage") {
      const value = task(
        rpc.params.message.parts[0]?.text,
        rpc.params.message.contextId,
      );
      reply(rpc.id, { task: publicTask(value) });
      return;
    }
    if (rpc.method === "GetTask" || rpc.method === "CancelTask") {
      const value = tasks.get(rpc.params.id);
      if (!value) {
        reply(rpc.id, undefined, { code: -32001, message: "Task not found" });
        return;
      }
      if (rpc.method === "CancelTask") {
        if (value.status.state === "TASK_STATE_COMPLETED") {
          reply(rpc.id, undefined, {
            code: -32002,
            message: "Task not cancelable",
          });
          return;
        }
        value.status.state = "TASK_STATE_CANCELED";
      } else if (!value.hold && ++value.polls >= 2) {
        value.status.state = value.fail
          ? "TASK_STATE_FAILED"
          : "TASK_STATE_COMPLETED";
        value.artifacts = [
          { artifactId: "answer", parts: [{ text: "research answer" }] },
        ];
      } else if (value.status.state === "TASK_STATE_SUBMITTED")
        value.status.state = "TASK_STATE_WORKING";
      reply(rpc.id, publicTask(value));
      return;
    }
    if (rpc.method === "ListTasks") {
      reply(rpc.id, {
        tasks: [...tasks.values()].map(publicTask),
        nextPageToken: "",
        pageSize: rpc.params.pageSize,
        totalSize: tasks.size,
      });
      return;
    }
    reply(rpc.id, rpc.params);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (http.address() as any).port;
});
after(async () => {
  await new Promise<void>((r) => {
    http.close(() => r());
    http.closeAllConnections();
  });
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "flowlet-a2a-cli-"));
  const store = new CredentialStore(dir);
  store.set("FLOWLET_A2A_TEST_URL", base + "/rpc", "service", null);
  store.set("FLOWLET_A2A_TEST_TOKEN", TOKEN, "api_key", null);
  mode = "normal";
  requests = [];
  counter = 0;
  fileReads = 0;
  tasks.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("generic A2A CLI through actual subprocess and HTTP boundaries", () => {
  it("lists agents and declared skills without a preselected profile and returns usable selectors", async () => {
    const store = new CredentialStore(dir);
    store.set("FLOWLET_A2A_URL", base + "/rpc", "service", null);
    store.set("FLOWLET_A2A_TOKEN", TOKEN, "api_key", null);
    store.set("DOCKHAND_URL", base + "/unrelated", "service", null);
    store.set("DOCKHAND_TOKEN", TOKEN, "api_key", null);
    mode = "list-secrets";
    const result = await run(["list"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.total, 2);
    assert.equal(report.available, 2);
    const research = report.agents.find((a: any) => a.profile === "TEST");
    assert.ok(research);
    assert.equal(research.prefix, "FLOWLET_A2A_TEST");
    assert.equal(research.name, "Independent research agent");
    assert.equal(research.skills[0].name, "Research");
    assert.deepEqual(research.skills[0].tags, ["analysis"]);
    assert.deepEqual(research.invoke, {
      command: "flowlet",
      args: ["a2a", "send", "<message>", "--profile=TEST"],
    });
    assert.ok(!result.stdout.includes(TOKEN));
    assert.ok(!result.stdout.includes("DOCKHAND"));
    const defaultAgent = report.agents.find(
      (a: any) => a.prefix === "FLOWLET_A2A",
    );
    assert.equal(defaultAgent.profile, null);
    assert.deepEqual(defaultAgent.invoke.args, ["a2a", "send", "<message>"]);
    const invoked = await run([
      ...research.invoke.args
        .slice(1)
        .map((arg: string) => (arg === "<message>" ? "discovered agent" : arg)),
      "--async",
    ]);
    assert.equal(invoked.code, 0, invoked.stderr);
  });
  it("isolates unavailable, incomplete and timed-out agents while keeping healthy results", async () => {
    const store = new CredentialStore(dir);
    store.set("FLOWLET_A2A_BAD_URL", base + "/unreachable", "service", null);
    store.set("FLOWLET_A2A_BAD_TOKEN", TOKEN, "api_key", null);
    store.set("FLOWLET_A2A_SLOW_URL", base + "/hanging", "service", null);
    store.set("FLOWLET_A2A_SLOW_TOKEN", TOKEN, "api_key", null);
    store.set("FLOWLET_A2A_MISSING_URL", base + "/rpc", "service", null);
    const result = await run(["list", "--timeout=1"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.total, 4);
    assert.equal(report.available, 1);
    assert.equal(report.unavailable, 3);
    assert.equal(
      report.agents.find((a: any) => a.profile === "TEST").available,
      true,
    );
    assert.match(
      report.agents.find((a: any) => a.profile === "BAD").error,
      /503/,
    );
    assert.match(
      report.agents.find((a: any) => a.profile === "SLOW").error,
      /超时/,
    );
    assert.match(
      report.agents.find((a: any) => a.profile === "MISSING").error,
      /缺少/,
    );
    assert.ok(!result.stdout.includes(TOKEN));
  });
  it("supports explicit custom prefixes and environment-only discovery without probing unrelated credentials", async () => {
    const store = new CredentialStore(dir);
    store.set("CUSTOM_AGENT_URL", base + "/rpc", "service", null);
    store.set("CUSTOM_AGENT_TOKEN", TOKEN, "api_key", null);
    let result = await run(["list", "--prefix=CUSTOM_AGENT"]);
    assert.equal(result.code, 0, result.stderr);
    const row = JSON.parse(result.stdout).agents[0];
    assert.equal(row.prefix, "CUSTOM_AGENT");
    assert.equal(row.profile, null);
    assert.deepEqual(row.invoke.args, [
      "a2a",
      "send",
      "<message>",
      "--prefix=CUSTOM_AGENT",
    ]);
    result = await child(["list"], undefined, {
      FLOWLET_A2A_ENV_URL: base + "/rpc",
      FLOWLET_A2A_ENV_TOKEN: TOKEN,
    }).result;
    assert.equal(
      JSON.parse(result.stdout).agents.find((a: any) => a.profile === "ENV")
        .available,
      true,
    );
    result = await child(["list"], undefined, {
      FLOWLET_A2A_ENV_URL: base + "/rpc",
    }).result;
    assert.match(
      JSON.parse(result.stdout).agents.find((a: any) => a.profile === "ENV")
        .error,
      /成对提供/,
    );
    result = await run(["list", "--profile=TEST"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).total, 1);
  });
  it("lists an empty vault without requiring a default profile or creating state", async () => {
    const store = new CredentialStore(dir);
    store.unset("FLOWLET_A2A_TEST_URL");
    store.unset("FLOWLET_A2A_TEST_TOKEN");
    const result = await run(["list"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.agents, []);
    assert.equal(report.total, 0);
    assert.match(report.hint, /flowlet pull/);
    assert.equal(existsSync(path.join(dir, "a2a-sessions")), false);
  });
  it("discovers a standard interface and waits for tasks without resending messages", async () => {
    let r = await run(["discover"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, "Independent research agent");
    r = await run(["send", "question with spaces", "--poll-ms=50"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      JSON.parse(r.stdout).task.status.state,
      "TASK_STATE_COMPLETED",
    );
    assert.equal(requests.filter((r) => r.method === "SendMessage").length, 1);
    assert.equal(requests.filter((r) => r.method === "GetTask").length, 2);
    assert.equal(
      requests[0].params.message.parts[0].text,
      "question with spaces",
    );
    assert.equal(requests[0].params.configuration.historyLength, 0);
  });
  it("continues across processes using context only and writes private state without tokens", async () => {
    const state = path.join(dir, "state.json");
    let r = await run(["send", "first", "--state", state, "--async"]);
    assert.equal(r.code, 0, r.stderr);
    const first = JSON.parse(r.stdout).task;
    r = await run(["send", "followup", "--state", state, "--async"]);
    assert.equal(r.code, 0, r.stderr);
    const sent = requests.filter((r) => r.method === "SendMessage");
    assert.equal(sent[1].params.message.contextId, first.contextId);
    assert.equal(sent[1].params.message.taskId, undefined);
    assert.ok(!readFileSync(state, "utf8").includes(TOKEN));
    if (process.platform !== "win32")
      assert.equal(statSync(state).mode & 0o777, 0o600);
    r = await run(["send", "new", "--new", "--state", state, "--async"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.at(-1).params.message.contextId, undefined);
    assert.equal(existsSync(state + ".lock"), false);
  });
  it("supports direct Message responses and named sessions without assuming task wrappers", async () => {
    let r = await run(["send", "direct", "--session=research"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).message.contextId, "direct-context");
    r = await run(["send", "followup", "--session=research", "--async"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.at(-1).params.message.contextId, "direct-context");
    r = await run(["session", "show", "--session=research"]);
    assert.equal(JSON.parse(r.stdout).taskId, "task-1");
    r = await run(["session", "clear", "--session=research"]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(["session", "show", "--session=research"]);
    assert.equal(JSON.parse(r.stdout), null);
  });
  it("passes raw attachments, arbitrary explicit MIME and JSON Parts; never downloads URL Parts", async () => {
    const file = path.join(dir, "sample.bin");
    writeFileSync(file, Buffer.from([0, 1, 2, 255]));
    let r = await run([
      "send",
      "analyze",
      "--file",
      file,
      "--media-type=application/example",
      '--data={"severity":"low"}',
      "--async",
    ]);
    assert.equal(r.code, 0, r.stderr);
    let parts = requests.at(-1).params.message.parts;
    assert.deepEqual(parts[1], { data: { severity: "low" } });
    assert.equal(parts[2].raw, "AAEC/w==");
    assert.equal(parts[2].mediaType, "application/example");
    r = await run([
      "send",
      "url",
      "--file-url=" + base + "/file.txt?sig=opaque",
      "--async",
    ]);
    assert.equal(r.code, 0, r.stderr);
    parts = requests.at(-1).params.message.parts;
    assert.equal(parts[1].url, base + "/file.txt?sig=opaque");
    assert.equal(fileReads, 0);
    const big = path.join(dir, "big.txt");
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024));
    const count = requests.length;
    r = await run(["send", "too big", "--file=" + big]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /超过4 MiB/);
    assert.equal(requests.length, count);
  });
  it("streams fragmented Unicode and multiline SSE as NDJSON, preserving IDs and final state", async () => {
    const r = await run(["send", "stream", "--stream", "--session=stream"]);
    assert.equal(r.code, 0, r.stderr);
    const events = r.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].task.id, "task-1");
    assert.equal(events[1].artifactUpdate.artifact.parts[0].text, "你好世界");
    assert.equal(events[2].statusUpdate.status.state, "TASK_STATE_COMPLETED");
  });
  it("rejects malformed successful responses instead of reporting completion", async () => {
    mode = "null-task";
    let result = await run(["send", "question"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /标准 Task/);
    assert.equal(requests.filter((r) => r.method === "SendMessage").length, 1);
    mode = "malformed-stream";
    result = await run(["send", "stream", "--stream"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /无效的 A2A SSE Task/);
  });
  it("records task IDs and fails unfinished streams, with no POST retry", async () => {
    mode = "dropped";
    const state = path.join(dir, "partial.json");
    const r = await run(["send", "stream", "--stream", "--state=" + state]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /未观察到终态/);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).taskId, "task-1");
    assert.equal(
      requests.filter((r) => r.method === "SendStreamingMessage").length,
      1,
    );
    assert.equal(existsSync(state + ".lock"), false);
  });
  it("manages get/list/cancel/subscribe with standard Task results and pagination filters", async () => {
    let r = await run(["send", "hold", "--async", "--session=task"]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(["tasks", "get", "--session=task"]);
    assert.equal(JSON.parse(r.stdout).id, "task-1");
    r = await run([
      "tasks",
      "list",
      "--context=context-1",
      "--status=TASK_STATE_WORKING",
      "--page-size=2",
      "--page-token=opaque",
      "--after=2026-01-01T00:00:00Z",
      "--include-artifacts",
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(requests.at(-1).params, {
      pageSize: 2,
      historyLength: 0,
      contextId: "context-1",
      status: "TASK_STATE_WORKING",
      pageToken: "opaque",
      statusTimestampAfter: "2026-01-01T00:00:00Z",
      includeArtifacts: true,
      tenant: "research",
    });
    r = await run(["tasks", "cancel", "--session=task"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status.state, "TASK_STATE_CANCELED");
    r = await run(["send", "hold", "--async"]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(["tasks", "subscribe", "task-2"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split("\n")[0]).task.id, "task-2");
    r = await run(["tasks", "subscribe", "task-2"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-32004/);
  });
  it("times out with saved state and does not retry a mutating operation", async () => {
    const state = path.join(dir, "timeout.json");
    const r = await run([
      "send",
      "hold",
      "--state=" + state,
      "--timeout=1",
      "--poll-ms=100",
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /未自动重发/);
    assert.equal(requests.filter((r) => r.method === "SendMessage").length, 1);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).taskId, "task-1");
    assert.equal(existsSync(state + ".lock"), false);
  });
  it("reports recoverable task IDs even without a local session file", async () => {
    const result = await run(["send", "hold", "--timeout=1", "--poll-ms=100"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /taskId=task-1/);
    assert.match(result.stderr, /contextId=context-1/);
    assert.equal(requests.filter((r) => r.method === "SendMessage").length, 1);
  });
  it("serializes sends to the same session while allowing another CLI to cancel", async () => {
    const state = path.join(dir, "busy.json");
    const active = child(["send", "hold", "--state=" + state, "--poll-ms=50"]);
    await until(() => existsSync(state));
    const blocked = await run(["send", "duplicate", "--state=" + state]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /其他命令/);
    const cancel = await run(["tasks", "cancel", "--state=" + state]);
    assert.equal(cancel.code, 0, cancel.stderr);
    const done = await active.result;
    assert.equal(done.code, 2, done.stderr);
    assert.equal(requests.filter((r) => r.method === "SendMessage").length, 1);
    assert.equal(existsSync(state + ".lock"), false);
  });
  it("interrupts only the local wait, releases locks and leaves the remote task running", async () => {
    const state = path.join(dir, "interrupt.json");
    const active = child(["send", "hold", "--state=" + state]);
    await until(() => existsSync(state));
    active.process.kill("SIGINT");
    const result = await active.result;
    assert.equal(result.code, 130, result.stderr);
    assert.equal(existsSync(state + ".lock"), false);
    assert.equal(
      requests.some((r) => r.method === "CancelTask"),
      false,
    );
    const queried = await run(["tasks", "get", "--state=" + state]);
    assert.equal(JSON.parse(queried.stdout).status.state, "TASK_STATE_WORKING");
  });
  it("binds explicit state to target and prefix, with an explicit new-session escape", async () => {
    const state = path.join(dir, "wrong.json");
    writeFileSync(
      state,
      JSON.stringify({
        schemaVersion: 1,
        endpoint: "https://other.example/rpc",
        prefix: "OTHER",
        contextId: "private-context",
      }),
    );
    let r = await run(["send", "question", "--state=" + state]);
    assert.equal(r.code, 1);
    assert.equal(requests.length, 0);
    r = await run(["send", "question", "--state=" + state, "--new", "--async"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.at(-1).params.message.contextId, undefined);
  });
  it("rejects cross-origin discovery and redirects before transmitting RPC credentials", async () => {
    for (const behavior of ["redirect", "cross-origin"]) {
      mode = behavior;
      const r = await run(["send", "question"]);
      assert.equal(r.code, 1);
      assert.equal(requests.length, 0);
      assert.equal(fileReads, 0);
    }
  });
  it("redacts tokens in errors, preserves protocol codes and exposes generic standard RPC", async () => {
    mode = "rpc-error";
    let r = await run(["discover", "--extended"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-32007/);
    assert.ok(!r.stderr.includes(TOKEN));
    mode = "normal";
    r = await run([
      "rpc",
      "CreateTaskPushNotificationConfig",
      '--params={"taskId":"t","url":"https://callback.example"}',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).url, "https://callback.example");
  });
  it("uses arbitrary credential prefixes and requires environment overrides as a pair", async () => {
    const store = new CredentialStore(dir);
    store.set("TEST_GENERIC_AGENT_URL", base + "/rpc", "service", null);
    store.set("TEST_GENERIC_AGENT_TOKEN", TOKEN, "api_key", null);
    let result = await run(["discover", "--prefix=TEST_GENERIC_AGENT"]);
    assert.equal(result.code, 0, result.stderr);
    const partial = await child(["discover"], undefined, {
      FLOWLET_A2A_TEST_URL: base + "/rpc",
    }).result;
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /成对提供/);
    store.set("FLOWLET_A2A_TEST_TOKEN", "wrong-vault-value", "api_key", null);
    const paired = await child(["discover"], undefined, {
      FLOWLET_A2A_TEST_URL: base + "/rpc",
      FLOWLET_A2A_TEST_TOKEN: TOKEN,
    }).result;
    assert.equal(paired.code, 0, paired.stderr);
  });
  it("parses spaced options and stdin without including option values in message text", async () => {
    const r = await run(
      ["send", "--stdin", "--session", "stdin-session", "--async"],
      "hello from stdin",
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      requests.at(-1).params.message.parts[0].text,
      "hello from stdin",
    );
    const failed = await run(["send", "fail", "--poll-ms=50"]);
    assert.equal(failed.code, 2, failed.stderr);
  });
});
