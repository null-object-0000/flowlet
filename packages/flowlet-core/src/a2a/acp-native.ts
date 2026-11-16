/** Native ACP sessions retain upstream configuration instead of losing it in A2A conversion. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpCommand } from "../storage/a2a.ts";
import { asObject as object, type JsonObject } from "./protocol.ts";
import type { AcpFrame } from "../../../flowlet-cred/src/acp-remote.ts";

type Session = {
  busy: boolean;
  models: Set<string>;
  emit?: (frame: AcpFrame) => Promise<void>;
};
function modelOptions(result: JsonObject, session: Session): JsonObject {
  const configOptions = (
    Array.isArray(result.configOptions) ? result.configOptions : []
  )
    .map(object)
    .filter((o) => o.category === "model" && o.type === "select");
  session.models = new Set(configOptions.map((o) => String(o.id)));
  return { ...result, modes: undefined, configOptions };
}

export async function startNativeAcp(
  config: AcpCommand,
  timeoutSeconds: number,
) {
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("FLOWLET_"),
      ),
    ),
    stdio: "pipe",
  });
  child.stderr.resume();
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const sessions = new Map<string, Session>();
  let creating = 0;
  const pending = new Map<
    string,
    {
      sessionId: string;
      options: Set<string>;
      resolve: (result: RequestPermissionResponse) => void;
    }
  >();
  const app = client({ name: "flowlet-remote" });
  app.onNotification(methods.client.session.update, async ({ params }) => {
    const session = sessions.get(params.sessionId);
    const update =
      params.update.sessionUpdate === "config_option_update"
        ? {
            ...params.update,
            ...modelOptions(
              params.update as unknown as JsonObject,
              session ?? { busy: false, models: new Set() },
            ),
          }
        : params.update;
    await session?.emit?.({ type: "update", params: { ...params, update } });
  });
  // These are the only reverse requests we implement. fs/*, terminal/* and MCP
  // execution have no handlers and are never advertised or sent to the caller.
  app.onRequest(
    methods.client.session.requestPermission,
    async ({ params, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session?.emit || pending.size >= 100)
        return { outcome: { outcome: "cancelled" as const } };
      const requestId = randomUUID();
      const abort = AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutSeconds * 1000),
      ]);
      return await new Promise<RequestPermissionResponse>((resolve) => {
        const done = (result: RequestPermissionResponse) => {
          abort.removeEventListener("abort", cancel);
          pending.delete(requestId);
          resolve(result);
        };
        const cancel = () => done({ outcome: { outcome: "cancelled" } });
        pending.set(requestId, {
          sessionId: params.sessionId,
          options: new Set(params.options.map((o) => o.optionId)),
          resolve: done,
        });
        abort.addEventListener("abort", cancel, { once: true });
        if (abort.aborted) return cancel();
        void session.emit!({
          type: "permission",
          requestId,
          params: params as unknown as JsonObject,
        }).catch(() => {
          cancel();
        });
      });
    },
  );
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), {
      maxMessageBytes: 4 * 1024 * 1024,
    }),
  );
  const peer = connection.agent;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  };
  const close = async () => {
    for (const item of pending.values())
      item.resolve({ outcome: { outcome: "cancelled" } });
    connection.close();
    child.stdin.end();
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 2000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  void connection.closed.then(
    () => {
      kill("SIGTERM");
    },
    () => {
      kill("SIGTERM");
    },
  );
  try {
    const init = await peer.request(
      methods.agent.initialize,
      { protocolVersion: 1, clientCapabilities: {} },
      {
        cancellationSignal: AbortSignal.timeout(10_000),
        stopWaitingOnCancel: true,
      },
    );
    return {
      closed,
      close,
      async call(
        method: string,
        raw: JsonObject,
        signal: AbortSignal,
        emit: (frame: AcpFrame) => Promise<void>,
      ): Promise<JsonObject> {
        signal = AbortSignal.any([
          signal,
          AbortSignal.timeout(timeoutSeconds * 1000),
        ]);
        signal.throwIfAborted();
        if (method === "initialize")
          return {
            protocolVersion: 1,
            agentInfo: init.agentInfo,
            agentCapabilities: {
              loadSession: init.agentCapabilities?.loadSession === true,
              promptCapabilities: {},
              mcpCapabilities: {},
            },
            authMethods: [],
          };
        if (method === "session/new") {
          if (sessions.size + creating >= 100)
            throw RequestError.invalidRequest(
              "Native ACP session limit reached; restart the runtime",
            );
          creating++;
          try {
            const result = await peer.request(
              methods.agent.session.new,
              { cwd: config.cwd, mcpServers: [] },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
            const session = { busy: false, models: new Set<string>() };
            sessions.set(result.sessionId, session);
            return modelOptions(result as unknown as JsonObject, session);
          } finally {
            creating--;
            if (signal.aborted) await close();
          }
        }
        const id = typeof raw.sessionId === "string" ? raw.sessionId : "";
        const session = sessions.get(id);
        if (!session) throw RequestError.sessionNotFound(id);
        if (method === "session/cancel") {
          for (const item of pending.values())
            if (item.sessionId === id)
              item.resolve({ outcome: { outcome: "cancelled" } });
          await peer.notify(methods.agent.session.cancel, { sessionId: id });
          return {};
        }
        if (method === "permission/reply") {
          const item = pending.get(String(raw.requestId));
          if (!item || item.sessionId !== id)
            throw RequestError.invalidParams(
              "Permission request is no longer pending",
            );
          const outcome = object(raw.outcome);
          if (
            outcome.outcome === "selected" &&
            typeof outcome.optionId === "string" &&
            item.options.has(outcome.optionId)
          )
            item.resolve({
              outcome: { outcome: "selected", optionId: outcome.optionId },
            });
          else if (outcome.outcome === "cancelled")
            item.resolve({ outcome: { outcome: "cancelled" } });
          else
            throw RequestError.invalidParams(
              "Permission option was not offered",
            );
          return {};
        }
        if (session.busy) throw RequestError.invalidRequest("Session is busy");
        session.busy = true;
        session.emit = emit;
        const cancel = () => {
          for (const item of pending.values())
            if (item.sessionId === id)
              item.resolve({ outcome: { outcome: "cancelled" } });
          void peer
            .notify(methods.agent.session.cancel, { sessionId: id })
            .catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (method === "session/load")
            return modelOptions(
              (await peer.request(
                methods.agent.session.load,
                { sessionId: id, cwd: config.cwd, mcpServers: [] },
                { cancellationSignal: signal, stopWaitingOnCancel: true },
              )) as unknown as JsonObject,
              session,
            );
          if (method === "session/set_config_option") {
            // Only model selectors may be changed remotely. Never expose mode/permission settings.
            if (
              !session.models.has(String(raw.configId)) ||
              typeof raw.value !== "string"
            )
              throw RequestError.invalidParams(
                "Only upstream model selectors may be changed",
              );
            return modelOptions(
              (await peer.request(
                methods.agent.session.setConfigOption,
                {
                  sessionId: id,
                  configId: String(raw.configId),
                  value: raw.value as string,
                },
                { cancellationSignal: signal, stopWaitingOnCancel: true },
              )) as unknown as JsonObject,
              session,
            );
          }
          if (method === "session/prompt") {
            if (
              !Array.isArray(raw.prompt) ||
              raw.prompt.some((p) => object(p).type !== "text")
            )
              throw RequestError.invalidParams(
                "Remote ACP accepts text prompts only; local resources are not forwarded",
              );
            return (await peer.request(
              methods.agent.session.prompt,
              {
                sessionId: id,
                prompt: raw.prompt as { type: "text"; text: string }[],
              },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            )) as unknown as JsonObject;
          }
          throw RequestError.methodNotFound(method);
        } finally {
          signal.removeEventListener("abort", cancel);
          if (signal.aborted) await close();
          session.busy = false;
          session.emit = undefined;
          for (const item of pending.values())
            if (item.sessionId === id)
              item.resolve({ outcome: { outcome: "cancelled" } });
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
