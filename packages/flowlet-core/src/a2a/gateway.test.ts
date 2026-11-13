import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, describe, it } from "node:test";
import { SqliteStorage } from "../storage/index.ts";
import { SecretBox } from "../storage/secret-box.ts";
import { createWebHost, type WebHost } from "../web/index.ts";
import { AdminAuth } from "../web/auth.ts";
import { validateAddress } from "./network.ts";
import { A2aObserver, a2aGateway } from "./gateway.ts";

const ADMIN = "a2a-test-admin-credential";
const UPSTREAM = "a2a-test-upstream-private-token";
let server: Server;
let upstream = "";
let web: WebHost;
let base = "";
let storage: SqliteStorage;
let directory = "";
let key = "";
let keyId = "";
let received: { body: string; authorization?: string }[] = [];
let behavior = "normal";
let endpointOrigin: string | null = null;
let streamBytes = "";
let capabilities: Record<string, unknown> = {
  streaming: true,
  pushNotifications: true,
  extendedAgentCard: true,
};
let extensionHeader: string | undefined;

function input(id = "research") {
  return {
    id,
    name: "Research",
    cardUrl: `${upstream}/.well-known/agent-card.json`,
    enabled: true,
    allowPrivateNetwork: true,
    timeoutSeconds: 10,
    upstreamToken: UPSTREAM,
  };
}
async function command(name: string, args = {}): Promise<any> {
  const res = await fetch(`${base}/api/commands/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}
async function call(
  method: string,
  token = key,
  agent = "research",
  params: unknown = {
    message: {
      role: "ROLE_USER",
      messageId: "msg-1",
      parts: [{ text: "你好" }],
    },
  },
) {
  return fetch(`${base}/a2a/${agent}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "a2a-version": "1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method, params }),
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    if (req.method === "GET") {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/.well-known/agent-card.json" });
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: "Research",
          description: "A generic independent agent",
          version: "1.0.0",
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          supportedInterfaces: [
            {
              url: `${endpointOrigin ?? upstream}/rpc`,
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
            },
          ],
          capabilities,
          skills: [
            {
              id: "research",
              name: "Research",
              description: "Research",
              tags: [],
            },
          ],
          signatures: [{ signature: "invalid-after-rewrite" }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    received.push({ body, authorization: req.headers.authorization });
    assert.equal(req.headers.authorization, `Bearer ${UPSTREAM}`);
    const rpc = JSON.parse(body);
    extensionHeader = req.headers["a2a-extensions"] as string | undefined;
    if (behavior === "missing-method") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "not implemented" },
        }),
      );
      return;
    }
    if (behavior === "specific-error") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32007,
            message: "ExtendedAgentCardNotConfiguredError",
            data: [{ "@type": "example", detail: "not configured" }],
          },
        }),
      );
      return;
    }
    if (rpc.method === "GetExtendedAgentCard") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            name: "Extended Research",
            description: "Extended private skills",
            version: "1.0",
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            capabilities,
            supportedInterfaces: [
              {
                url: upstream + "/rpc",
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            signatures: [{ signature: "upstream" }],
            securitySchemes: { private: {} },
            security: [{ private: [] }],
            skills: [
              {
                id: "private-skill",
                name: "Private skill",
                description: "Private skill",
                tags: [],
              },
            ],
          },
        }),
      );
      return;
    }
    if (behavior === "empty-error") {
      res.writeHead(429);
      res.end();
      return;
    }
    if (behavior === "partial" || behavior === "hang") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        "data: " +
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              task: {
                id: "partial",
                contextId: "partial-context",
                status: { state: "TASK_STATE_WORKING" },
              },
            },
          }) +
          "\n\n",
      );
      if (behavior === "partial") res.end();
      return;
    }
    if (behavior === "invalid-json") {
      res.setHeader("content-type", "application/json");
      res.end("{broken");
      return;
    }
    if (behavior === "echo") {
      res.setHeader("content-type", "application/json");
      res.setHeader("a2a-extensions", "https://example.com/ext");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { message: { ...rpc.params.message, role: "ROLE_AGENT" } },
        }),
      );
      return;
    }
    if (behavior === "error") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "invalid task" },
        }),
      );
      return;
    }
    if (
      rpc.method === "SendStreamingMessage" ||
      rpc.method === "SubscribeToTask"
    ) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      streamBytes =
        ": keepalive\n\ndata: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            task: {
              id: "t-stream",
              contextId: "c-stream",
              status: { state: "TASK_STATE_WORKING" },
            },
          },
        }) +
        "\n\ndata: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            statusUpdate: {
              taskId: "t-stream",
              contextId: "c-stream",
              status: {
                state: "TASK_STATE_COMPLETED",
                message: { parts: [{ text: "你好世界" }] },
              },
            },
          },
        }) +
        "\n\n: done\n\n";
      // Split inside UTF-8 and JSON boundaries.
      const bytes = Buffer.from(streamBytes);
      for (let i = 0; i < bytes.length; i += 7)
        res.write(bytes.subarray(i, i + 7));
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    const result =
      rpc.method === "ListTasks"
        ? { tasks: [] }
        : {
            task: {
              id: "task-1",
              contextId: "context-1",
              status: {
                state:
                  rpc.method === "CancelTask"
                    ? "TASK_STATE_CANCELED"
                    : "TASK_STATE_COMPLETED",
              },
              artifacts: [{ artifactId: "answer", parts: [{ text: "你好" }] }],
            },
          };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  directory = mkdtempSync(path.join(tmpdir(), "flowlet-a2a-"));
  writeFileSync(path.join(directory, "config.json"), "{}");
  storage = new SqliteStorage(path.join(directory, "test.db"));
  const bindConfig = {
    host: "127.0.0.1",
    port: 0,
    allow_lan: false,
    default_client_token: "model-token",
  };
  const snapshot = {
    channels: [],
    accounts: [],
    routes: [],
    rules: [],
    virtual_models: [],
  };
  web = createWebHost({
    storage,
    secrets: SecretBox.loadOrCreate(directory),
    proxy: {
      start: async () => {},
      stop: async () => {},
      status: () => ({
        running: false,
        bind_addr: "127.0.0.1:0",
        started_at: null,
      }),
      bindConfig: () => bindConfig,
      setBindConfig: () => {},
    },
    runtimeConfig: {
      snapshot: () => snapshot,
      replace: () => {},
      update: (fn) => fn(snapshot),
    },
    bindConfig,
    configPath: path.join(directory, "config.json"),
    catalogDir: directory,
    staticDir: directory,
    adminToken: ADMIN,
    auth: AdminAuth.fromEnv({
      FLOWLET_ADMIN_AUTH_MODE: "token",
      FLOWLET_ADMIN_TOKEN: ADMIN,
    }),
    clientToken: "model-token",
    publicProxyUrl: "",
    deviceIdentity: {
      schema_version: 1,
      device_id: "test",
      created_at: "2026-11-12",
      display_name: "Test",
      platform: "linux",
      app_version: "test",
    },
  });
  await web.listen("127.0.0.1:0");
  base = `http://127.0.0.1:${web.address()!.port}`;
});
after(async () => {
  await web?.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  storage?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("generic A2A gateway through real Host command and HTTP boundaries", () => {
  it("observes multiline SSE frames split inside UTF-8 without changing payloads", () => {
    const observer = new A2aObserver();
    const event =
      JSON.stringify(
        {
          result: {
            task: {
              id: "task-unicode",
              contextId: "中文",
              status: { state: "TASK_STATE_COMPLETED" },
            },
          },
        },
        null,
        2,
      )
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\r\n") + "\r\n\r\n";
    for (const byte of Buffer.from(event)) observer.feed(Buffer.from([byte]));
    assert.equal(observer.contextId, "中文");
    assert.equal(observer.taskId, "task-unicode");
    assert.equal(observer.finished, true);
  });
  it("rejects private/metadata/tunneled destinations unless explicitly allowed", () => {
    assert.throws(() => validateAddress("127.0.0.1", false));
    assert.doesNotThrow(() => validateAddress("10.1.2.3", true));
    for (const ip of [
      "169.254.169.254",
      "0.0.0.0",
      "::ffff:127.0.0.1",
      "fe80::1",
      "ff02::1",
    ])
      assert.throws(() => validateAddress(ip, true));
  });
  it("registers a card, encrypts upstream credentials and returns no secret", async () => {
    const agent = await command("save_a2a_agent", { input: input() });
    assert.equal(agent.endpoint, `${upstream}/rpc`);
    assert.equal(agent.hasUpstreamToken, true);
    assert.ok(!JSON.stringify(agent).includes(UPSTREAM));
    assert.ok(!("tokenCipher" in agent));
    const stored = storage
      .database()
      .prepare("SELECT value FROM a2a_agents")
      .get()!;
    assert.ok(!String(stored.value).includes(UPSTREAM));
    const created = await command("create_a2a_key", {
      name: "Hermes",
      agentIds: ["research"],
    });
    key = created.token;
    keyId = created.id;
    assert.ok(
      !JSON.stringify(
        storage.database().prepare("SELECT * FROM a2a_keys").all(),
      ).includes(key),
    );
  });
  it("rejects cross-origin endpoints and card redirects without following them", async () => {
    endpointOrigin = "https://other.example.com";
    const bad = await fetch(`${base}/api/commands/save_a2a_agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: input("other") }),
    });
    assert.equal(bad.status, 400);
    endpointOrigin = null;
    const redirect = await fetch(`${base}/api/commands/inspect_a2a_agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: { ...input(), cardUrl: `${upstream}/redirect` },
      }),
    });
    assert.equal(redirect.status, 400);
  });
  it("requires scoped data-plane keys and never accepts admin/model tokens", async () => {
    for (const token of ["", ADMIN, "model-token"])
      assert.equal((await call("SendMessage", token)).status, 401);
    await command("save_a2a_agent", { input: input("second") });
    assert.equal((await call("SendMessage", key, "second")).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/commands/list_a2a_agents`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: "{}",
        })
      ).status,
      401,
    );
  });
  it("rewrites discovery to gateway URLs/security and drops invalid signatures", async () => {
    const r = await fetch(`${base}/a2a/research/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const card: any = await r.json();
    assert.equal(card.supportedInterfaces[0].url, `${base}/a2a/research`);
    assert.equal(card.signatures, undefined);
    assert.deepEqual(card.securityRequirements, [
      { schemes: { flowlet: { list: [] } } },
    ]);
    assert.deepEqual(
      card.skills[0].securityRequirements,
      card.securityRequirements,
    );
    assert.equal(card.capabilities.pushNotifications, true);
    assert.equal(
      card.securitySchemes.flowlet.httpAuthSecurityScheme.scheme,
      "bearer",
    );
  });
  it("passes IDs and payload unchanged, replaces credentials, observes real task state", async () => {
    const res = await call("SendMessage");
    const result: any = await res.json();
    assert.equal(result.result.task.id, "task-1");
    assert.equal(JSON.parse(received.at(-1)!.body).id, "rpc-1");
    assert.equal(received.at(-1)!.authorization, `Bearer ${UPSTREAM}`);
    const logs = await command("list_a2a_calls");
    assert.equal(logs[0].taskId, "task-1");
    assert.equal(logs[0].contextId, "context-1");
    assert.equal(logs[0].state, "TASK_STATE_COMPLETED");
  });
  it("streams exact bytes, including keepalives, and observes the terminal event", async () => {
    const res = await call("SendStreamingMessage");
    assert.equal(await res.text(), streamBytes);
    const logs = await command("list_a2a_calls");
    assert.equal(logs[0].taskId, "t-stream");
    assert.equal(logs[0].state, "TASK_STATE_COMPLETED");
    assert.equal(logs[0].error, null);
  });
  it("forwards task query, listing and cancellation without creating another task", async () => {
    for (const method of ["GetTask", "ListTasks", "CancelTask"]) {
      const res = await call(method, key, "research", {
        id: "task-1",
        contextId: "context-1",
      });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      assert.equal(JSON.parse(received.at(-1)!.body).method, method);
    }
  });
  it("subscribes without issuing a new message and preserves SSE bytes", async () => {
    const response = await call("SubscribeToTask", key, "research", {
      id: "t-stream",
    });
    assert.equal(await response.text(), streamBytes);
    assert.equal(JSON.parse(received.at(-1)!.body).method, "SubscribeToTask");
  });
  it("passes raw files, URLs, structured data and asynchronous configuration unchanged", async () => {
    behavior = "echo";
    const params = {
      message: {
        messageId: "multipart",
        role: "ROLE_USER",
        contextId: "context-1",
        referenceTaskIds: ["old-task"],
        parts: [
          { raw: "aGVsbG8=", mediaType: "image/png", filename: "tiny.png" },
          {
            url: "https://files.example/document.pdf",
            mediaType: "application/pdf",
          },
          { data: { severity: "low", rows: [1, 2] } },
        ],
      },
      configuration: {
        returnImmediately: true,
        historyLength: 0,
        acceptedOutputModes: ["application/json"],
      },
      metadata: { trace: "opaque" },
    };
    const response = await call("SendMessage", key, "research", params);
    assert.equal(
      response.headers.get("a2a-extensions"),
      "https://example.com/ext",
    );
    const value = (await response.json()) as any;
    assert.deepEqual(value.result.message.parts, params.message.parts);
    assert.deepEqual(JSON.parse(received.at(-1)!.body).params, params);
    behavior = "normal";
  });
  it("distinguishes invalid upstream responses from specific protocol errors", async () => {
    behavior = "invalid-json";
    assert.equal(
      ((await (await call("GetTask")).json()) as any).error.code,
      -32006,
    );
    behavior = "specific-error";
    const response = await call("GetExtendedAgentCard");
    const value = (await response.json()) as any;
    assert.equal(value.error.code, -32007);
    assert.equal(value.error.data[0].detail, "not configured");
    behavior = "normal";
    for (const state of [
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_AUTH_REQUIRED",
    ]) {
      const observer = new A2aObserver();
      observer.observe({
        result: { statusUpdate: { taskId: "awaiting", status: { state } } },
      });
      assert.equal(observer.finished, true);
      assert.equal(observer.state, state);
    }
  });
  it("forwards every push configuration operation with its original payload", async () => {
    for (const method of [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
    ]) {
      const params = {
        taskId: "task-1",
        id: "notify-1",
        url: "https://callback.example/notify",
        token: "callback-credential",
        authentication: { scheme: "Bearer", credentials: "callback-secret" },
      };
      const response = await call(method, key, "research", params);
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(JSON.parse(received.at(-1)!.body).params, params);
    }
  });
  it("rewrites authenticated extended cards while preserving private skills", async () => {
    const response = await call(
      "GetExtendedAgentCard",
      key,
      "research",
      undefined,
    );
    const card = ((await response.json()) as any).result;
    assert.equal(card.name, "Extended Research");
    assert.equal(card.skills[0].id, "private-skill");
    assert.equal(card.supportedInterfaces[0].url, base + "/a2a/research");
    assert.equal(card.signatures, undefined);
    assert.deepEqual(card.security, [{ flowlet: [] }]);
    const noParams = await fetch(base + "/a2a/research", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "GetExtendedAgentCard",
      }),
    });
    assert.equal(
      ((await noParams.json()) as any).result.name,
      "Extended Research",
    );
  });
  it("returns canonical errors for optional capabilities and records local rejections", async () => {
    const previous = capabilities;
    capabilities = {};
    await command("save_a2a_agent", { input: input("limited") });
    const limitedKey = await command("create_a2a_key", {
      name: "limited",
      agentIds: ["limited"],
    });
    capabilities = previous;
    const count = received.length;
    for (const [method, code] of [
      ["SendStreamingMessage", -32004],
      ["SubscribeToTask", -32004],
      ["GetExtendedAgentCard", -32004],
      ["CreateTaskPushNotificationConfig", -32003],
      ["GetTaskPushNotificationConfig", -32003],
      ["ListTaskPushNotificationConfigs", -32003],
      ["DeleteTaskPushNotificationConfig", -32003],
    ] as const) {
      const response = await call(method, limitedKey.token, "limited");
      const value = (await response.json()) as any;
      assert.equal(value.error.code, code);
      assert.equal(value.id, "rpc-1");
    }
    const nested = await call("SendMessage", limitedKey.token, "limited", {
      message: { parts: [{ text: "hi" }] },
      configuration: {
        taskPushNotificationConfig: { url: "https://callback.example" },
      },
    });
    assert.equal(((await nested.json()) as any).error.code, -32003);
    assert.equal(received.length, count);
    const logs = await command("list_a2a_calls", { agentId: "limited" });
    assert.match(logs[0].error, /NotSupported|Unsupported/);
    behavior = "missing-method";
    const unsupported = await call("CancelTask");
    assert.equal(((await unsupported.json()) as any).error.code, -32004);
    behavior = "normal";
  });
  it("negotiates versions and required extensions without leaking arbitrary headers", async () => {
    const previous = capabilities;
    capabilities = {
      ...previous,
      extensions: [{ uri: "https://example.com/ext", required: true }],
    };
    await command("save_a2a_agent", { input: input("extended") });
    capabilities = previous;
    const extKey = await command("create_a2a_key", {
      name: "extensions",
      agentIds: ["extended"],
    });
    const count = received.length;
    for (const version of ["", "0.3", "2.0"]) {
      const response = await fetch(base + "/a2a/extended", {
        method: "POST",
        headers: {
          authorization: `Bearer ${extKey.token}`,
          "a2a-version": version,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ListTasks" }),
      });
      assert.equal(((await response.json()) as any).error.code, -32009);
    }
    const missing = await call("ListTasks", extKey.token, "extended", {});
    assert.equal(((await missing.json()) as any).error.code, -32008);
    assert.equal(received.length, count);
    const response = await fetch(base + "/a2a/extended", {
      method: "POST",
      headers: {
        authorization: `Bearer ${extKey.token}`,
        "a2a-version": "1.0",
        "a2a-extensions": "https://example.com/ext",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ListTasks" }),
    });
    assert.equal(((await response.json()) as any).result.tasks.length, 0);
    assert.equal(extensionHeader, "https://example.com/ext");
  });
  it("records JSON-RPC errors even when upstream HTTP status is 200; does not retry", async () => {
    behavior = "error";
    const count = received.length;
    const res = await call("GetTask");
    assert.equal(((await res.json()) as any).error.message, "invalid task");
    assert.equal(received.length, count + 1);
    behavior = "normal";
    const logs = await command("list_a2a_calls");
    assert.equal(logs[0].httpStatus, 200);
    assert.equal(logs[0].error, "invalid task");
  });
  it("honors capture switches, size limits and retention", async () => {
    web.context.logCapture.capture_req_body = false;
    web.context.logCapture.capture_res_body = false;
    await (await call("SendMessage")).arrayBuffer();
    let logs = await command("list_a2a_calls");
    assert.equal(logs[0].requestBody, null);
    assert.equal(logs[0].responseBody, null);
    web.context.logCapture.capture_req_body = true;
    web.context.logCapture.capture_res_body = true;
    web.context.logCapture.max_body_bytes = 20;
    await (await call("SendMessage")).arrayBuffer();
    logs = await command("list_a2a_calls");
    assert.ok(Buffer.byteLength(logs[0].requestBody) <= 20);
    assert.ok(Buffer.byteLength(logs[0].responseBody) <= 20);
    web.context.logCapture.body_retention_days = -1;
    web.context.logCapture.body_max_size_mb = 0;
    logs = await command("list_a2a_calls");
    assert.ok(
      logs[0].requestBody,
      "-1 day retention and 0 MB limit preserve bodies",
    );
    web.context.logCapture.body_retention_days = 0;
    logs = await command("list_a2a_calls");
    assert.ok(
      logs.every((l: { requestBody: unknown }) => l.requestBody === null),
    );
  });
  it("preserves empty error statuses and records unfinished SSE as incomplete", async () => {
    behavior = "empty-error";
    const empty = await call("SendMessage");
    assert.equal(empty.status, 429);
    assert.equal(await empty.text(), "");
    behavior = "partial";
    const partial = await call("SendStreamingMessage");
    await partial.text();
    behavior = "normal";
    const logs = await command("list_a2a_calls");
    assert.equal(logs[0].state, "TASK_STATE_WORKING");
    assert.match(logs[0].error, /未观察到终态/);
  });
  it("rejects invalid JSON/methods as JSON-RPC errors without invoking the agent", async () => {
    const count = received.length;
    const unknown = await call("NotAMethod");
    assert.equal(((await unknown.json()) as any).error.code, -32601);
    const invalid = await fetch(`${base}/a2a/research`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: "{",
    });
    assert.equal(((await invalid.json()) as any).error.code, -32700);
    assert.equal(received.length, count);
  });
  it("aborts the outgoing stream when the caller disconnects and records it", async () => {
    behavior = "hang";
    const controller = new AbortController();
    const res = await fetch(`${base}/a2a/research`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "a2a-version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "abort",
        method: "SendStreamingMessage",
        params: {},
      }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    behavior = "normal";
    for (let i = 0; i < 100; i++) {
      const logs = await command("list_a2a_calls");
      if (logs[0]?.error?.includes("中断")) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("caller disconnect was not recorded");
  });
  it("preserves stored credentials on edit, hot-disables and revokes keys", async () => {
    await command("save_a2a_agent", {
      input: { ...input(), upstreamToken: undefined, enabled: false },
    });
    assert.equal((await call("SendMessage")).status, 404);
    await command("save_a2a_agent", {
      input: { ...input(), upstreamToken: undefined },
    });
    assert.equal((await call("SendMessage")).status, 200);
    await command("revoke_a2a_key", { id: keyId });
    assert.equal((await call("SendMessage")).status, 401);
    await command("delete_a2a_agent", { id: "research" });
    assert.equal((await call("SendMessage")).status, 404);
    assert.ok((await command("list_a2a_calls")).length > 0);
  });
  it("drains aborted A2A work before the Host closes its database", async () => {
    const created = await command("create_a2a_key", {
      name: "shutdown",
      agentIds: ["second"],
    });
    behavior = "hang";
    const res = await call("SendStreamingMessage", created.token, "second");
    const reading = res.text().catch(() => "disconnected");
    await web.close();
    await reading;
    const logs = a2aGateway(web.context).calls("second");
    assert.match(logs[0].error!, /中断/);
  });
});
