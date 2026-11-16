import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  client,
  methods,
  type ClientContext,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { createAcpBridge } from "../acp.ts";

async function fixture(
  run: (value: {
    peer: ClientContext;
    sessionId: string;
    updates: SessionUpdate[];
    sends: any[];
    mode: (value: string) => void;
  }) => Promise<void>,
  ignoreClientMcp = false,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "flowlet-acp-contract-"));
  const token = "private-acp-contract-token";
  let mode = "artifacts",
    url = "";
  const sends: any[] = [],
    updates: SessionUpdate[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: "Fixture",
          supportedInterfaces: [
            { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          ],
          capabilities: { streaming: true },
          skills: [],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    if (rpc.method === "GetTask") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            id: "task",
            contextId: "context",
            status: {
              state:
                mode === "dropped"
                  ? "TASK_STATE_WORKING"
                  : "TASK_STATE_INPUT_REQUIRED",
            },
          },
        }),
      );
      return;
    }
    sends.push(rpc.params.message);
    res.setHeader("content-type", "text/event-stream");
    const event = (result: unknown) =>
      res.write(
        "data: " +
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) +
          "\n\n",
      );
    if (mode === "direct") {
      event({
        message: {
          messageId: "reply",
          contextId: "context",
          role: "ROLE_AGENT",
          parts: [
            { text: "直接消息" },
            { data: { ok: true } },
            { url: "https://example.com/file", filename: "file" },
            { raw: "aGk=", mediaType: "text/plain" },
          ],
        },
      });
    } else {
      event({
        task: {
          id: "task",
          contextId: "context",
          status: { state: "TASK_STATE_WORKING" },
        },
      });
      if (mode === "artifacts") {
        for (const [text, append] of [
          ["old", false],
          ["+append", true],
          ["最终答案", false],
        ])
          event({
            artifactUpdate: {
              taskId: "task",
              contextId: "context",
              artifact: { artifactId: "answer", parts: [{ text }] },
              append,
            },
          });
      }
      if (mode !== "dropped")
        event({
          statusUpdate: {
            taskId: "task",
            contextId: "context",
            status: {
              state:
                mode === "paused"
                  ? "TASK_STATE_INPUT_REQUIRED"
                  : "TASK_STATE_COMPLETED",
              ...(mode === "paused"
                ? { message: { parts: [{ text: "Choose a permission" }] } }
                : {}),
            },
          },
        });
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/rpc`;
  try {
    const app = client({ name: "test" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params.update);
      },
    );
    await app.connectWith(
      createAcpBridge({
        url,
        token,
        prefix: "TEST",
        dir: directory,
        timeoutSeconds: 3,
        ignoreClientMcp,
      }),
      async (peer) => {
        await peer.request(methods.agent.initialize, { protocolVersion: 1 });
        const { sessionId } = await peer.request(methods.agent.session.new, {
          cwd: directory,
          mcpServers: [],
        });
        await run({
          peer,
          sessionId,
          updates,
          sends,
          mode: (value) => {
            mode = value;
          },
        });
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
const prompt = (peer: ClientContext, sessionId: string) =>
  peer.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });

it("preserves artifact append/replace, direct messages and inline data without fetching file URLs", () =>
  fixture(async ({ peer, sessionId, updates, mode, sends }) => {
    assert.equal((await prompt(peer, sessionId)).stopReason, "end_turn");
    const contents = updates
      .filter((update) => "content" in update)
      .map((update) =>
        JSON.stringify("content" in update ? update.content : null),
      );
    assert.ok(contents.some((value) => value.includes("old+append")));
    assert.ok(contents.some((value) => value.includes("最终答案")));
    const final = updates.filter(
      (update) => update.sessionUpdate === "agent_message_chunk",
    );
    assert.equal(JSON.stringify(final).includes("old"), false);
    mode("direct");
    await prompt(peer, sessionId);
    assert.equal(sends[1].contextId, "context");
    assert.equal(sends[1].taskId, undefined);
    assert.match(JSON.stringify(updates), /data:text\/plain;base64,aGk=/);
    assert.match(JSON.stringify(updates), /example.com\/file/);
  }));
it("continues only a paused task", () =>
  fixture(async ({ peer, sessionId, mode, sends }) => {
    mode("paused");
    await prompt(peer, sessionId);
    mode("artifacts");
    await prompt(peer, sessionId);
    assert.equal(sends[1].taskId, "task");
    await prompt(peer, sessionId);
    assert.equal(sends[2].taskId, undefined);
  }));
it("does not resend a task after an unfinished stream or while the previous task is active", () =>
  fixture(async ({ peer, sessionId, mode, sends }) => {
    mode("dropped");
    await assert.rejects(prompt(peer, sessionId), /stream ended/);
    await assert.rejects(
      prompt(peer, sessionId),
      /Previous task is still running/,
    );
    assert.equal(sends.length, 1);
    await assert.rejects(
      peer.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "aA==", mimeType: "image/png" }],
      }),
      { code: -32602 },
    );
    assert.equal(sends.length, 1);
  }));

it("allows T3's injected MCP only with explicit remote-only opt-in and exposes an honest model option", () =>
  fixture(async ({ peer, updates, sends }) => {
    const session = await peer.request(methods.agent.session.new, {
      cwd: "/remote-workspace",
      mcpServers: [
        { name: "t3-code", command: "must-not-run", args: [], env: [] },
      ],
    });
    assert.equal(session.configOptions?.[0].currentValue, "default");
    assert.match(JSON.stringify(session.configOptions), /上游默认/);
    await peer.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: "model",
      value: "default",
    });
    await assert.rejects(
      peer.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "invented-model",
      }),
      /model switching is not available/,
    );
    await prompt(peer, session.sessionId);
    await prompt(peer, session.sessionId);
    assert.equal(
      updates.filter((update) =>
        JSON.stringify(update).includes("客户端附带的 MCP 配置未传递给上游"),
      ).length,
      1,
    );
    assert.equal(JSON.stringify(sends).includes("must-not-run"), false);
  }, true));
