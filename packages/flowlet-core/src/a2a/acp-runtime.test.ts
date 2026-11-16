import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AcpRuntimes, acpCapabilities, acpCommand } from "./acp-runtime.ts";
import type { WebContext } from "../web/context.ts";
import { A2aClient, object } from "../../../flowlet-cred/src/a2a.ts";
import { createAcpBridge, promptParts } from "../../../flowlet-cred/src/acp.ts";

const fixture = fileURLToPath(
  new URL("../../../flowlet-agent-bridge/test-agent.mjs", import.meta.url),
);
const acp = {
  command: process.execPath,
  args: [fixture],
  cwd: path.dirname(fixture),
};
const ctx = {} as WebContext;
describe(
  "ACP real stdio runtime and bidirectional bridge",
  { timeout: 30_000 },
  () => {
    it("denies process registration on Web by default and validates commands without a shell", async () => {
      const previous = process.env.FLOWLET_ENABLE_ACP;
      delete process.env.FLOWLET_ENABLE_ACP;
      try {
        assert.equal(acpCapabilities(ctx).acpRegistration, false);
        await assert.rejects(
          new AcpRuntimes(ctx).probe("fixture", acp, 10),
          /未启用/,
        );
        assert.throws(
          () => acpCommand({ ...acp, command: "node\nsh" }),
          /无效/,
        );
        assert.throws(
          () => acpCommand({ ...acp, cwd: "relative" }),
          /绝对目录/,
        );
        assert.deepEqual(acpCommand(acp), acp);
      } finally {
        if (previous === undefined) delete process.env.FLOWLET_ENABLE_ACP;
        else process.env.FLOWLET_ENABLE_ACP = previous;
      }
    });
    it("streams ACP through A2A, restores ACP conversations, preserves context and kills runtimes", async () => {
      const previous = process.env.FLOWLET_ENABLE_ACP;
      process.env.FLOWLET_ENABLE_ACP = "1";
      const runtimes = new AcpRuntimes(ctx);
      const dir = mkdtempSync(path.join(tmpdir(), "flowlet-acp-"));
      try {
        const runtime = await runtimes.ensure({
          id: "fixture",
          name: "Fixture",
          acp,
          timeoutSeconds: 10,
        });
        assert.equal(
          (await fetch(runtime.endpoint + ".well-known/agent-card.json"))
            .status,
          401,
        );
        const api = new A2aClient(runtime.endpoint, runtime.token, {
          signal: AbortSignal.timeout(15_000),
        });
        try {
          await api.discover();
          const task = await api.call("SendMessage", {
            message: {
              role: "ROLE_USER",
              messageId: "initial",
              parts: [{ text: "你好" }],
            },
          });
          assert.equal(
            object(object(task.task).status).state,
            "TASK_STATE_COMPLETED",
          );
          assert.match(JSON.stringify(task), /你好/);
        } finally {
          await api.close();
        }

        const config = {
          url: runtime.endpoint,
          token: runtime.token,
          prefix: "TEST",
          dir,
          timeoutSeconds: 15,
        };
        const updates: SessionUpdate[] = [];
        const app = client({ name: "contract-test" }).onNotification(
          methods.client.session.update,
          ({ params }) => {
            updates.push(params.update);
          },
        );
        let sessionId = "";
        await app.connectWith(createAcpBridge(config), async (peer) => {
          const init = await peer.request(methods.agent.initialize, {
            protocolVersion: 1,
            clientCapabilities: {},
          });
          assert.equal(init.agentCapabilities?.loadSession, true);
          await assert.rejects(
            peer.request(methods.agent.session.new, {
              cwd: dir,
              mcpServers: [{ name: "bad", command: "bad", args: [], env: [] }],
            }),
            { code: -32602 },
          );
          ({ sessionId } = await peer.request(methods.agent.session.new, {
            cwd: dir,
            mcpServers: [],
          }));
          for (const text of ["一", "二"]) {
            const result = await peer.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            assert.equal(result.stopReason, "end_turn");
          }
          assert.match(JSON.stringify(updates), /第2轮/);
        });
        const count = updates.length;
        await app.connectWith(createAcpBridge(config), async (peer) => {
          await peer.request(methods.agent.initialize, { protocolVersion: 1 });
          await peer.request(methods.agent.session.load, {
            sessionId,
            cwd: dir,
            mcpServers: [],
          });
          assert.equal(updates.length, count * 2 + 2); // replay also includes both user prompts
          await peer.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "三" }],
          });
          assert.match(JSON.stringify(updates), /第3轮/);
          await assert.doesNotReject(
            peer.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "permission" }],
            }),
            "permission must pause",
          );
          assert.match(JSON.stringify(updates), /Allow once/);
          await assert.doesNotReject(
            peer.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "allow" }],
            }),
            "permission answer must resume",
          );
          assert.match(JSON.stringify(updates), /selected/);
          const pending = peer.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hold" }],
          });
          for (
            let i = 0;
            i < 200 && !JSON.stringify(updates).includes("waiting");
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.match(JSON.stringify(updates), /waiting/);
          await assert.rejects(
            peer.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "duplicate" }],
            }),
            { code: -32600 },
          );
          await peer.notify(methods.agent.session.cancel, { sessionId });
          assert.equal(
            (
              await pending.catch((error) => {
                throw new Error("cancel must finish", { cause: error });
              })
            ).stopReason,
            "cancelled",
          );
        });
        assert.throws(
          () =>
            promptParts([
              { type: "image", data: "aA==", mimeType: "image/png" },
            ]),
          { code: -32602 },
        );
        const cli = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../../flowlet-cred/src/cli.ts", import.meta.url),
            ),
            "acp",
            "--profile=TEST",
          ],
          {
            env: {
              ...process.env,
              FLOWLET_CRED_DIR: dir,
              FLOWLET_A2A_TEST_URL: runtime.endpoint,
              FLOWLET_A2A_TEST_TOKEN: runtime.token,
            },
            stdio: "pipe",
          },
        );
        let stderr = "";
        cli.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        const exited = new Promise<number | null>((resolve) =>
          cli.once("close", resolve),
        );
        try {
          await app.connectWith(
            ndJsonStream(Writable.toWeb(cli.stdin), Readable.toWeb(cli.stdout)),
            async (peer) => {
              await peer.request(methods.agent.initialize, {
                protocolVersion: 1,
              });
              const session = await peer.request(methods.agent.session.new, {
                cwd: dir,
                mcpServers: [],
              });
              assert.equal(
                (
                  await peer.request(methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "stdio" }],
                  })
                ).stopReason,
                "end_turn",
              );
            },
          );
          cli.stdin.end();
          assert.equal(await exited, 0, stderr);
          assert.equal(stderr.includes(runtime.token), false);
        } finally {
          cli.kill();
        }
        await runtimes.stop("fixture");
        await runtime.closed;
        await assert.rejects(fetch(runtime.endpoint));
      } finally {
        await runtimes.close();
        rmSync(dir, { recursive: true, force: true });
        if (previous === undefined) delete process.env.FLOWLET_ENABLE_ACP;
        else process.env.FLOWLET_ENABLE_ACP = previous;
      }
    });
  },
);
