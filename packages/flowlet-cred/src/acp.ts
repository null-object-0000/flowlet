// ACP v1 agent backed by a standard A2A 1.0 endpoint. No agent-specific APIs.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import {
  agent,
  methods,
  RequestError,
  PROTOCOL_VERSION,
  type ContentBlock,
  type StopReason,
  type SessionUpdate,
  type AgentContext,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
  type SetSessionConfigOptionResponse,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { A2aClient, END_STATES, object, type A2aObject } from "./a2a.ts";
import { SessionFile, type A2aSession } from "./a2a-session.ts";
import path from "node:path";
import { writeAtomic } from "./store.ts";
import { ACP_SESSION_EXTENSION, RemoteAcp } from "./acp-remote.ts";
import { nativePrompt } from "./acp-prompt.ts";

export interface AcpBridgeConfig {
  url: string;
  token: string;
  prefix: string;
  dir: string;
  timeoutSeconds: number;
  extensions?: string;
  ignoreClientMcp?: boolean;
}
type Session = {
  file: SessionFile;
  state: A2aSession | null;
  cwd: string;
  history: SessionUpdate[];
  active?: { taskId?: string; cancelled: boolean; cancel?: Promise<void> };
};

function saveHistory(session: Session) {
  const text = JSON.stringify({
    version: 1,
    cwd: session.cwd,
    history: session.history,
  });
  if (Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw new Error(
      "ACP conversation history exceeds 8 MiB; create a new session",
    );
  writeAtomic(session.file.file + ".acp", text);
}

export function promptParts(blocks: ContentBlock[]): A2aObject[] {
  return blocks.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "resource_link")
      return {
        url: block.uri,
        filename: block.name,
        mediaType: block.mimeType ?? "application/octet-stream",
      };
    // The bridge only advertises baseline content. Reject rather than silently drop attachments.
    throw RequestError.invalidParams(
      "This bridge accepts text and resource_link content only",
    );
  });
}
function partsText(parts: unknown): string {
  return (Array.isArray(parts) ? parts : [])
    .map((raw) => {
      const part = object(raw);
      if (typeof part.text === "string") return part.text;
      if (typeof part.url === "string")
        return `${part.filename ?? "Attachment"}: ${part.url}`;
      if (part.data !== undefined) return JSON.stringify(part.data);
      if (typeof part.raw === "string")
        return `${part.filename ?? "Attachment"}: data:${part.mediaType ?? "application/octet-stream"};base64,${part.raw}`;
      throw new Error("Unsupported A2A output part");
    })
    .join("");
}

export function createAcpBridge(config: AcpBridgeConfig) {
  const sessions = new Map<string, Session>();
  let card: A2aObject = {};
  let native: RemoteAcp | undefined;
  let supportsAuthUrl = false;
  let nativeImages = false;
  const contextFor = (url: string) => {
    const dir = path.join(config.dir, "acp-identities");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(
      dir,
      createHash("sha256")
        .update(JSON.stringify([url, config.prefix]))
        .digest("hex") + ".key",
    );
    try {
      writeFileSync(file, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (object(error).code !== "EEXIST") throw error;
    }
    const value = readFileSync(file, "utf8");
    if (!/^[a-f0-9]{64}$/.test(value))
      throw new Error("Invalid private ACP identity file");
    return value;
  };
  const remote = async (
    method: string,
    params: A2aObject,
    signal: AbortSignal,
    peer?: AgentContext,
    authRequestId?: string | number,
  ) => {
    if (!native) throw new Error("Native ACP is not available");
    signal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.timeoutSeconds * 1000),
    ]);
    try {
      return await native.call(method, params, signal, async (frame) => {
        if (!peer) throw new Error("Unexpected remote ACP callback");
        if (frame.type === "update") {
          await peer.notify(methods.client.session.update, frame.params);
        } else if (frame.type === "elicitation") {
          let result: A2aObject = { action: "cancel" };
          if (
            supportsAuthUrl &&
            frame.params.mode === "url" &&
            authRequestId !== undefined
          ) {
            try {
              const response = await peer.request<A2aObject>(
                methods.client.elicitation.create,
                { ...frame.params, requestId: authRequestId },
                { cancellationSignal: signal, stopWaitingOnCancel: true },
              );
              if (
                ["accept", "decline", "cancel"].includes(
                  String(response.action),
                )
              )
                result = { action: response.action };
            } catch {
              /* cancellation remains a cancellation, never implicit consent */
            }
          }
          await native!.call(
            "elicitation/reply",
            { requestId: frame.requestId, result },
            signal,
          );
        } else if (frame.type === "permission") {
          let result: A2aObject;
          try {
            result = await peer.request<A2aObject>(
              methods.client.session.requestPermission,
              frame.params,
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
          } catch (error) {
            // A disconnected observer leaves the hosted question pending for reconnection.
            if (signal.aborted) return;
            if (object(error).code !== -32601) throw error;
            result = { outcome: { outcome: "cancelled" } };
          }
          await native!.call(
            "permission/reply",
            {
              sessionId: frame.params.sessionId,
              requestId: frame.requestId,
              outcome: result.outcome,
            },
            signal,
          );
        }
      });
    } catch (error) {
      throw new RequestError(
        typeof object(error).code === "number"
          ? Number(object(error).code)
          : -32603,
        (error instanceof Error ? error.message : "Remote ACP failed")
          .split(config.token)
          .join("[redacted]"),
        object(error).data,
      );
    }
  };
  const client = (signal: AbortSignal) =>
    new A2aClient(config.url, config.token, {
      signal,
      extensions: config.extensions,
    });
  const find = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw RequestError.sessionNotFound(id);
    return session;
  };
  const file = (id: string) =>
    new SessionFile(config.dir, config.url, config.prefix, `acp:${id}`);
  const app = agent({ name: "flowlet" });
  for (const [local, method] of [
    ["_flowlet/start", "session/start"],
    ["_flowlet/status", "session/status"],
    ["_flowlet/subscribe", "session/subscribe"],
  ]) {
    app.onRequest(
      local!,
      (value: unknown) => object(value),
      async ({ params, signal, client: peer }) =>
        await remote(method!, params, signal, peer),
    );
  }
  const configOptions = () => [
    {
      id: "model",
      category: "model" as const,
      name: "模型",
      type: "select" as const,
      currentValue: "default",
      options: [
        {
          value: "default",
          name: `${String(card.name ?? "远程 Agent")} · 上游默认`,
          description:
            "底层模型由远程 A2A Agent 管理，当前未提供模型切换能力。",
        },
      ],
    },
  ];
  const checkMcp = (servers: unknown[]) => {
    if (servers.length && !config.ignoreClientMcp)
      throw new RequestError(
        -32602,
        "Remote A2A agents cannot use client MCP servers. Disable MCP injection, or explicitly use --ignore-client-mcp for remote-only operation.",
      );
  };
  app.onRequest(methods.agent.initialize, async ({ params, signal }) => {
    supportsAuthUrl =
      object(object(params.clientCapabilities).elicitation).url != null;
    const api = client(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    try {
      card = await api.discover();
      if (
        (Array.isArray(object(card.capabilities).extensions)
          ? (object(card.capabilities).extensions as unknown[])
          : []
        ).some((ext) => object(ext).uri === ACP_SESSION_EXTENSION)
      ) {
        native = new RemoteAcp(
          api.endpoint.href,
          config.token,
          contextFor(api.endpoint.href),
        );
        const initialized = (await remote(
          "initialize",
          {},
          signal,
        )) as unknown as InitializeResponse;
        nativeImages =
          initialized.agentCapabilities?.promptCapabilities?.image === true;
        return initialized;
      }
    } finally {
      await api.close();
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "flowlet",
        title: String(card.name),
        version: "0.2.0",
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        mcpCapabilities: {},
      },
      authMethods: [],
    };
  });
  app.onRequest(
    methods.agent.authenticate,
    async ({ params, signal, client: peer, requestId }) => {
      if (!native) throw RequestError.methodNotFound("authenticate");
      await remote(
        "authenticate",
        {
          methodId: params.methodId,
          ...(params._meta ? { _meta: params._meta } : {}),
        },
        signal,
        peer,
        requestId ?? undefined,
      );
      return {};
    },
  );
  app.onRequest(methods.agent.logout, async ({ signal }) => {
    if (!native) throw RequestError.methodNotFound("logout");
    await remote("logout", {}, signal);
    return {};
  });
  app.onRequest(methods.agent.session.list, async ({ params, signal }) => {
    if (!native) throw RequestError.methodNotFound("session/list");
    return (await remote(
      "session/list",
      { cursor: params.cursor },
      signal,
    )) as unknown as import("@agentclientprotocol/sdk").ListSessionsResponse;
  });
  app.onRequest(
    methods.agent.session.resume,
    async ({ params, signal, client: peer }) => {
      checkMcp(params.mcpServers ?? []);
      if (!native) throw RequestError.methodNotFound("session/resume");
      return (await remote(
        "session/resume",
        { sessionId: params.sessionId },
        signal,
        peer,
      )) as unknown as import("@agentclientprotocol/sdk").ResumeSessionResponse;
    },
  );
  app.onRequest(methods.agent.session.close, async ({ params, signal }) => {
    if (!native) throw RequestError.methodNotFound("session/close");
    return await remote(
      "session/close",
      { sessionId: params.sessionId },
      signal,
    );
  });
  app.onRequest(methods.agent.session.delete, async ({ params, signal }) => {
    if (!native) throw RequestError.methodNotFound("session/delete");
    return await remote(
      "session/delete",
      { sessionId: params.sessionId },
      signal,
    );
  });
  app.onRequest(methods.agent.session.new, async ({ params, signal }) => {
    checkMcp(params.mcpServers);
    if (native) {
      const result = (await remote(
        "session/new",
        {},
        signal,
      )) as unknown as NewSessionResponse;
      return result;
    }
    if (sessions.size >= 100)
      throw RequestError.invalidRequest(
        "Session limit reached; restart the bridge",
      );
    const id = randomUUID(),
      record = file(id);
    const unlock = record.lock();
    let state: A2aSession | null;
    try {
      state = record.save(null, { contextId: randomUUID() });
    } finally {
      unlock();
    }
    const session = {
      file: record,
      state,
      cwd: params.cwd,
      history: [],
    };
    saveHistory(session);
    sessions.set(id, session);
    return { sessionId: id, configOptions: configOptions() };
  });
  app.onRequest(
    methods.agent.session.setConfigOption,
    async ({ params, signal, client: peer }) => {
      if (native)
        return (await remote(
          "session/set_config_option",
          { ...params },
          signal,
          peer,
        )) as unknown as SetSessionConfigOptionResponse;
      find(params.sessionId);
      if (params.configId !== "model" || params.value !== "default")
        throw new RequestError(
          -32602,
          "This remote A2A agent exposes its upstream default only; model switching is not available.",
        );
      return { configOptions: configOptions() };
    },
  );
  app.onRequest(
    methods.agent.session.load,
    async ({ params, signal, client: peer }) => {
      checkMcp(params.mcpServers);
      if (native) {
        const result = (await remote(
          "session/load",
          { sessionId: params.sessionId },
          signal,
          peer,
        )) as unknown as LoadSessionResponse;
        return result;
      }
      if (!/^[a-f0-9-]{36}$/.test(params.sessionId))
        throw RequestError.sessionNotFound(params.sessionId);
      if (sessions.get(params.sessionId)?.active)
        throw RequestError.invalidRequest("Session is busy");
      const record = file(params.sessionId),
        unlock = record.lock();
      try {
        const state = record.read();
        if (!state) throw RequestError.sessionNotFound(params.sessionId);
        if (sessions.size >= 100 && !sessions.has(params.sessionId))
          throw RequestError.invalidRequest("Session limit reached");
        if (statSync(record.file + ".acp").size > 8 * 1024 * 1024)
          throw new Error("ACP history exceeds limit");
        const history = JSON.parse(readFileSync(record.file + ".acp", "utf8"));
        if (
          history.version !== 1 ||
          !Array.isArray(history.history) ||
          history.cwd !== params.cwd
        )
          throw RequestError.invalidParams("Session workspace does not match");
        for (const update of history.history)
          await peer.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update,
          });
        sessions.set(params.sessionId, {
          file: record,
          state,
          cwd: params.cwd,
          history: history.history,
        });
        return { configOptions: configOptions() };
      } finally {
        unlock();
      }
    },
  );
  const cancelTask = async (session: Session) => {
    const active = session.active;
    if (!active?.taskId || active.cancel) return active?.cancel;
    active.cancel = (async () => {
      const api = client(AbortSignal.timeout(10_000));
      try {
        await api.discover();
        await api.call("CancelTask", { id: active.taskId });
      } finally {
        await api.close();
      }
    })();
    return active.cancel;
  };
  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    if (native) {
      await remote(
        "session/cancel",
        { ...params },
        AbortSignal.timeout(10_000),
      );
      return;
    }
    const session = find(params.sessionId);
    if (!session.active) return;
    session.active.cancelled = true;
    await cancelTask(session);
  });
  app.onRequest(
    methods.agent.session.prompt,
    async ({ params, signal, client: peer }) => {
      if (native) {
        let prompt: ContentBlock[];
        try {
          prompt = nativePrompt(params.prompt, nativeImages);
        } catch (error) {
          throw new RequestError(
            -32602,
            error instanceof Error
              ? error.message
              : "Invalid native ACP prompt",
          );
        }
        return (await remote(
          "session/prompt",
          { sessionId: params.sessionId, prompt },
          signal,
          peer,
        )) as unknown as PromptResponse;
      }
      const session = find(params.sessionId);
      if (session.active) throw RequestError.invalidRequest("Session is busy");
      const parts = promptParts(params.prompt);
      if (!parts.length) throw RequestError.invalidParams("Prompt is empty");
      const unlock = session.file.lock();
      const active: NonNullable<Session["active"]> = { cancelled: false };
      session.active = active;
      const api = client(
        AbortSignal.any([
          signal,
          AbortSignal.timeout(config.timeoutSeconds * 1000),
        ]),
      );
      let state: string | undefined;
      const artifacts = new Map<string, { parts: A2aObject[]; name: string }>();
      let messageReceived = false;
      const notify = async (update: SessionUpdate) => {
        session.history.push(update);
        saveHistory(session);
        await peer.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
      };
      const say = (text: string) =>
        text
          ? notify({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            })
          : Promise.resolve();
      const observe = async (event: A2aObject) => {
        session.state = session.file.save(session.state, event);
        const item = object(
          event.task ??
            event.statusUpdate ??
            event.artifactUpdate ??
            event.message ??
            event,
        );
        if (typeof item.taskId === "string") active.taskId = item.taskId;
        if (typeof item.id === "string" && item.status) active.taskId = item.id;
        if (active.cancelled) await cancelTask(session);
        const current = object(item.status).state;
        if (typeof current === "string") {
          state = current;
          const text = partsText(object(object(item.status).message).parts);
          if (text) await say(text + "\n");
        }
        if (event.message) {
          messageReceived = true;
          await say(partsText(object(event.message).parts));
        }
        const updates = event.artifactUpdate
          ? [object(event.artifactUpdate)]
          : Array.isArray(item.artifacts)
            ? item.artifacts.map((artifact) => ({ artifact, append: false }))
            : [];
        for (const update of updates) {
          const artifact = object(update.artifact),
            id = String(artifact.artifactId ?? "response");
          const previous = artifacts.get(id);
          const next = Array.isArray(artifact.parts)
            ? artifact.parts.map(object)
            : [];
          const value = {
            name: String(artifact.name ?? previous?.name ?? "Agent output"),
            parts:
              update.append === true && previous
                ? [...previous.parts, ...next]
                : next,
          };
          artifacts.set(id, value);
          if (
            Buffer.byteLength(JSON.stringify([...artifacts])) >
            4 * 1024 * 1024
          )
            throw new Error("A2A artifacts exceed 4 MiB");
          // An A2A artifact is output, not a client tool invocation. Accumulate
          // replacements and appends; emit the final snapshot as a message.
        }
      };
      try {
        session.state = session.file.read();
        await api.discover();
        card = api.card;
        if (session.state?.taskId) {
          const previous = await api.call("GetTask", {
            id: session.state.taskId,
          });
          const previousState = String(object(previous.status).state);
          if (!END_STATES.has(previousState))
            throw new Error(
              "Previous task is still running; query or cancel it before sending another prompt",
            );
          if (
            !["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"].includes(
              previousState,
            )
          ) {
            session.state = session.file.save(session.state, {
              message: { contextId: session.state.contextId },
            });
          }
        }
        for (const content of params.prompt) {
          session.history.push({
            sessionUpdate: "user_message_chunk",
            content,
          });
        }
        saveHistory(session);
        const message = {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts,
          ...(session.state?.contextId
            ? { contextId: session.state.contextId }
            : {}),
          ...(session.state?.taskId ? { taskId: session.state.taskId } : {}),
        };
        // Only continue a paused task. Completed tasks must never be submitted again.
        if (object(card.capabilities).streaming === true) {
          for await (const event of api.stream("SendStreamingMessage", {
            message,
          })) {
            await observe(event);
            if (messageReceived || END_STATES.has(String(state))) break;
          }
        } else {
          const result = await api.call("SendMessage", {
            message,
            configuration: { returnImmediately: true },
          });
          await observe(result);
          if (result.task && !END_STATES.has(String(state))) {
            const task = await api.wait(object(result.task), 0, 500, () => {});
            await observe({ task });
          }
        }
        if (!messageReceived && !END_STATES.has(String(state)))
          throw new Error(
            "A2A stream ended without a terminal or paused task; message was not retried",
          );
        for (const value of artifacts.values()) {
          await say(partsText(value.parts) + "\n");
        }
        const paused =
          state === "TASK_STATE_INPUT_REQUIRED" ||
          state === "TASK_STATE_AUTH_REQUIRED";
        if (!paused) {
          session.state = session.file.save(session.state, {
            message: { contextId: session.state?.contextId },
          });
        } else if (!artifacts.size) {
          await say(
            "Agent is waiting for input or authentication. Reply to continue this task.\n",
          );
        }
        if (state === "TASK_STATE_FAILED")
          throw new Error(
            "A2A task failed; see the Agent output and Flowlet call record",
          );
        const stopReason: StopReason =
          state === "TASK_STATE_CANCELED"
            ? "cancelled"
            : state === "TASK_STATE_REJECTED"
              ? "refusal"
              : "end_turn";
        return { stopReason };
      } catch (error) {
        throw new RequestError(-32603, api.clean(error));
      } finally {
        session.active = undefined;
        await api.close();
        unlock();
      }
    },
  );
  return app;
}
