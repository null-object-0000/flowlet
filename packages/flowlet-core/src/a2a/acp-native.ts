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
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type { AcpCommand } from "../storage/a2a.ts";
import { asObject as object, type JsonObject } from "./protocol.ts";
import type { AcpFrame } from "../../../flowlet-cred/src/acp-remote.ts";

type Session = {
  busy: boolean;
  closing?: boolean;
  models: Set<string>;
  emit?: (frame: AcpFrame) => Promise<void>;
};
function modelOptions(result: JsonObject, session: Session): JsonObject {
  const configOptions = (
    Array.isArray(result.configOptions) ? result.configOptions : []
  )
    .map(object)
    .filter(
      (o) =>
        ["model", "thought_level"].includes(String(o.category)) &&
        o.type === "select",
    );
  session.models = new Set(configOptions.map((o) => String(o.id)));
  return { ...result, modes: undefined, configOptions };
}

export async function startNativeAcp(
  config: AcpCommand,
  timeoutSeconds: number,
  contextId?: string,
) {
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("FLOWLET_"),
        ),
      ),
      ...(contextId ? { FLOWLET_ACP_CONTEXT_ID: contextId } : {}),
    },
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
  let authEmit: ((frame: AcpFrame) => Promise<void>) | undefined;
  const elicitations = new Map<
    string,
    (result: CreateElicitationResponse) => void
  >();
  const app = client({ name: "flowlet-remote" });
  app.onRequest(
    methods.client.elicitation.create,
    async ({ params, signal }) => {
      // Authentication uses consented, out-of-band URLs only. Never collect secrets in forms.
      if (
        !contextId ||
        !authEmit ||
        params.mode !== "url" ||
        typeof params.url !== "string" ||
        elicitations.size >= 8
      )
        return { action: "cancel" };
      const url = new URL(params.url);
      if (
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        throw RequestError.invalidParams(
          "Authentication requires HTTPS or loopback URL",
        );
      const id = randomUUID();
      return await new Promise<CreateElicitationResponse>((resolve) => {
        const done = (result: CreateElicitationResponse) => {
          signal.removeEventListener("abort", cancel);
          elicitations.delete(id);
          resolve(result);
        };
        const cancel = () => done({ action: "cancel" });
        elicitations.set(id, done);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) return cancel();
        void authEmit!({
          type: "elicitation",
          requestId: id,
          params: params as unknown as JsonObject,
        }).catch(cancel);
      });
    },
  );
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
    for (const resolve of elicitations.values()) resolve({ action: "cancel" });
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
      {
        protocolVersion: 1,
        clientCapabilities: contextId ? { elicitation: { url: {} } } : {},
      },
      {
        cancellationSignal: AbortSignal.timeout(10_000),
        stopWaitingOnCancel: true,
      },
    );
    return {
      closed,
      close,
      requiresClientContext: Boolean(init.authMethods?.length),
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
              sessionCapabilities: Object.fromEntries(
                (["list", "resume", "close", "delete"] as const)
                  .filter(
                    (name) =>
                      init.agentCapabilities?.sessionCapabilities?.[name],
                  )
                  .map((name) => [name, {}]),
              ),
              ...(contextId && init.agentCapabilities?.auth?.logout
                ? { auth: { logout: {} } }
                : {}),
              promptCapabilities: {},
              mcpCapabilities: {},
            },
            authMethods: contextId
              ? (init.authMethods ?? []).filter(
                  (m) => !("type" in m && m.type === "terminal"),
                )
              : [],
          };
        if (method === "elicitation/reply") {
          const resolve = elicitations.get(String(raw.requestId));
          if (!contextId || !resolve)
            throw RequestError.invalidParams(
              "Authentication interaction is no longer pending",
            );
          const action = object(raw.result).action;
          if (!["accept", "decline", "cancel"].includes(String(action)))
            throw RequestError.invalidParams(
              "Invalid authentication interaction response",
            );
          resolve({ action: String(action) });
          return {};
        }
        if (method === "authenticate" || method === "logout") {
          const offered = (init.authMethods ?? []).filter(
            (m) => !("type" in m && m.type === "terminal"),
          );
          if (
            !contextId ||
            !offered.length ||
            (method === "logout" && !init.agentCapabilities?.auth?.logout)
          )
            throw RequestError.methodNotFound(method);
          if (
            authEmit ||
            [...sessions.values()].some((s) => s.busy || s.closing)
          )
            throw RequestError.invalidRequest(
              "Finish active operations before changing account",
            );
          if (
            method === "authenticate" &&
            !offered.some((m) => m.id === raw.methodId)
          )
            throw RequestError.invalidParams(
              "Authentication method was not advertised",
            );
          authEmit = emit;
          try {
            const result =
              method === "authenticate"
                ? await peer.request(
                    methods.agent.authenticate,
                    {
                      methodId: String(raw.methodId),
                      ...(raw._meta ? { _meta: object(raw._meta) } : {}),
                    },
                    { cancellationSignal: signal, stopWaitingOnCancel: true },
                  )
                : await peer.request(
                    methods.agent.logout,
                    {},
                    { cancellationSignal: signal, stopWaitingOnCancel: true },
                  );
            sessions.clear();
            // Auth state is private to the upstream process; never return credentials or metadata.
            return {};
          } finally {
            for (const resolve of elicitations.values())
              resolve({ action: "cancel" });
            authEmit = undefined;
            if (signal.aborted) await close();
          }
        }
        if (authEmit)
          throw RequestError.invalidRequest("Authentication is in progress");
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
        if (method === "session/list") {
          if (!init.agentCapabilities?.sessionCapabilities?.list)
            throw RequestError.methodNotFound(method);
          return (await peer.request(
            methods.agent.session.list,
            {
              cwd: config.cwd,
              ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
            },
            { cancellationSignal: signal, stopWaitingOnCancel: true },
          )) as unknown as JsonObject;
        }
        const id = typeof raw.sessionId === "string" ? raw.sessionId : "";
        const lifecycle =
          method === "session/load" || method === "session/resume";
        if (method === "session/load" && !init.agentCapabilities?.loadSession)
          throw RequestError.methodNotFound(method);
        for (const name of ["resume", "close", "delete"] as const)
          if (
            method === `session/${name}` &&
            !init.agentCapabilities?.sessionCapabilities?.[name]
          )
            throw RequestError.methodNotFound(method);
        const restored = !sessions.has(id) && lifecycle;
        if (restored) {
          if (!id || id.length > 512)
            throw RequestError.invalidParams("Invalid session ID");
          if (sessions.size + creating >= 100)
            throw RequestError.invalidRequest("Session limit reached");
          sessions.set(id, { busy: false, models: new Set() });
        }
        const session = sessions.get(id);
        if (
          !session &&
          (method === "session/delete" || method === "session/close")
        ) {
          return (await peer.request(
            method === "session/delete"
              ? methods.agent.session.delete
              : methods.agent.session.close,
            { sessionId: id },
            { cancellationSignal: signal, stopWaitingOnCancel: true },
          )) as unknown as JsonObject;
        }
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
        if (method === "session/close") {
          if (session.closing)
            throw RequestError.invalidRequest("Session is closing");
          session.closing = true;
          try {
            for (const item of pending.values())
              if (item.sessionId === id)
                item.resolve({ outcome: { outcome: "cancelled" } });
            const result = await peer.request(
              methods.agent.session.close,
              { sessionId: id },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
            sessions.delete(id);
            return result as unknown as JsonObject;
          } finally {
            session.closing = false;
          }
        }
        if (session.closing)
          throw RequestError.invalidRequest("Session is closing");
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
        let succeeded = false;
        try {
          if (method === "session/delete") {
            const result = await peer.request(
              methods.agent.session.delete,
              { sessionId: id },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
            sessions.delete(id);
            return result as unknown as JsonObject;
          }
          if (lifecycle) {
            const result = modelOptions(
              (await peer.request(
                method === "session/load"
                  ? methods.agent.session.load
                  : methods.agent.session.resume,
                { sessionId: id, cwd: config.cwd, mcpServers: [] },
                { cancellationSignal: signal, stopWaitingOnCancel: true },
              )) as unknown as JsonObject,
              session,
            );
            succeeded = true;
            return result;
          }
          if (method === "session/set_config_option") {
            // Only standard model/thought-level selectors; permission modes stay private.
            if (
              !session.models.has(String(raw.configId)) ||
              typeof raw.value !== "string"
            )
              throw RequestError.invalidParams(
                "Only upstream model or thought-level selectors may be changed",
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
          if (restored && !succeeded) sessions.delete(id);
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
