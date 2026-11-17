import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  client,
  methods,
  agentProtocolRouter,
} from "@agentclientprotocol/sdk/experimental/v2";
import { createAcpBridge } from "../../../flowlet-cred/src/acp.ts";
import { createAcpV2Bridge } from "../../../flowlet-cred/src/acp-v2.ts";
import { startNativeAcp } from "./acp-native.ts";
import { ManagedAcp, MANAGED } from "./acp-managed.ts";
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
it(
  "real ACP v2 + HTTP + native stdio keeps running after client exits, reconnects tools/progress and explicitly stops",
  { timeout: 15000 },
  async () => {
    const fixture = fileURLToPath(
      new URL("../../../flowlet-agent-bridge/test-agent.mjs", import.meta.url),
    );
    const runtime = await startNativeAcp(
      {
        command: process.execPath,
        args: [fixture],
        cwd: path.dirname(fixture),
      },
      10,
    );
    const managed = new ManagedAcp(runtime.call.bind(runtime), 10);
    let endpoint = "";
    const dir = mkdtempSync(path.join(tmpdir(), "flowlet-reconnect-"));
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            name: "managed fixture",
            supportedInterfaces: [
              {
                url: endpoint,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            capabilities: {
              extensions: [{ uri: "urn:flowlet:acp-session:1" }],
            },
            skills: [],
          }),
        );
        return;
      }
      let raw = "";
      for await (const b of req) raw += b;
      const body = JSON.parse(raw),
        abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      res.setHeader("content-type", "text/event-stream");
      const emit = async (f: any) => {
        if (abort.signal.aborted) throw Error("Observer left");
        res.write(`data: ${JSON.stringify(f)}\n\n`);
      };
      try {
        const result = await managed.call(
          body.method,
          body.params,
          abort.signal,
          emit,
        );
        await emit({ type: "result", result });
      } catch (e: any) {
        if (!abort.signal.aborted)
          await emit({
            type: "error",
            code: e.code ?? -32603,
            message: e.message,
          });
      } finally {
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    endpoint = `http://127.0.0.1:${(server.address() as any).port}/agent`;
    const connect = async (
      updates: any[],
      fn: (peer: any) => Promise<void>,
      permission?: (params: any) => Promise<any>,
    ) => {
      const bridge = createAcpV2Bridge(
        createAcpBridge({
          url: endpoint,
          token: "test",
          prefix: "RECONNECT",
          dir,
          timeoutSeconds: 10,
        }),
      );
      const app = client({ name: "reconnect-test" }).onNotification(
        methods.client.session.update,
        ({ params }) => {
          updates.push(params.update);
        },
      );
      if (permission)
        app.onRequest(methods.client.session.requestPermission, ({ params }) =>
          permission(params),
        );
      try {
        const a = new TransformStream<any>(),
          b = new TransformStream<any>();
        agentProtocolRouter()
          .withV2(bridge.app)
          .connect({ writable: a.writable, readable: b.readable });
        await app.connectWith(
          { readable: a.readable, writable: b.writable },
          async (peer) => {
            await peer.request(methods.agent.initialize, {
              protocolVersion: 2,
              info: { name: "test", version: "1" },
              capabilities: {},
            });
            await fn(peer);
          },
        );
      } finally {
        bridge.close();
      }
    };
    let sessionId = "";
    try {
      const first: any[] = [];
      await connect(first, async (peer) => {
        ({ sessionId } = await peer.request(methods.agent.session.new, {
          cwd: dir,
          mcpServers: [],
        }));
        const changed = await peer.request(
          methods.agent.session.setConfigOption,
          { sessionId, configId: "model", type: "id", value: "fixture-large" },
        );
        assert.equal(changed.configOptions[0].configId, "model");
        assert.equal(changed.configOptions[0].currentValue, "fixture-large");
        const result = await peer.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "background-count" }],
        });
        assert.ok(result.messageId);
        while (!first.some((u) => u.sessionUpdate === "agent_message_chunk"))
          await new Promise((r) => setTimeout(r, 5));
      });
      const status = await managed.call(
        "session/status",
        { sessionId },
        AbortSignal.timeout(1000),
        async () => {},
      );
      assert.equal((status._meta as any)[MANAGED].state, "running");
      const second: any[] = [];
      await connect(second, async (peer) => {
        await peer.request(methods.agent.session.resume, {
          sessionId,
          cwd: dir,
          replayFrom: { type: "start" },
        });
        while (
          !second.some(
            (u) => u.sessionUpdate === "state_update" && u.state === "idle",
          )
        )
          await new Promise((r) => setTimeout(r, 5));
      });
      assert.ok(second.some((u) => u.sessionUpdate === "replay_complete"));
      assert.ok(
        second.some(
          (u) => u.sessionUpdate === "state_update" && u.state === "running",
        ),
      );
      const text = second
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join("");
      assert.equal(
        text,
        Array.from({ length: 8 }, (_, i) => `turn=1,step=${i + 1};`).join(""),
      );
      assert.ok(
        second.some(
          (u) =>
            u.sessionUpdate === "tool_call_update" && u.status === "completed",
        ),
      );
      const stopped: any[] = [];
      await connect(stopped, async (peer) => {
        await peer.request(methods.agent.session.resume, {
          sessionId,
          cwd: dir,
        });
        await peer.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "background-count" }],
        });
        await peer.notify(methods.agent.session.cancel, { sessionId });
        while (
          !stopped.some(
            (u) =>
              u.sessionUpdate === "state_update" &&
              u.stopReason === "cancelled",
          )
        )
          await new Promise((r) => setTimeout(r, 5));
      });
      const asked = defer(),
        permissionUpdates: any[] = [];
      await connect(
        permissionUpdates,
        async (peer) => {
          await peer.request(methods.agent.session.resume, {
            sessionId,
            cwd: dir,
          });
          await peer.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "permission" }],
          });
          await asked.promise;
        },
        async () => {
          asked.resolve();
          return new Promise(() => {});
        },
      );
      const waiting = await managed.call(
        "session/status",
        { sessionId },
        AbortSignal.timeout(1000),
        async () => {},
      );
      assert.equal((waiting._meta as any)[MANAGED].state, "waiting");
      let consent = 0;
      const final: any[] = [];
      await connect(
        final,
        async (peer) => {
          await peer.request(methods.agent.session.resume, {
            sessionId,
            cwd: dir,
            replayFrom: { type: "start" },
          });
          while (
            !final.some(
              (u) => u.sessionUpdate === "state_update" && u.state === "idle",
            )
          )
            await new Promise((r) => setTimeout(r, 5));
        },
        async (params) => {
          consent++;
          return {
            outcome: {
              outcome: "selected",
              optionId: params.options[0].optionId,
            },
          };
        },
      );
      assert.equal(consent, 1);
    } finally {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
