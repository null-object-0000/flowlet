// ACP v1 agent backed by a standard A2A 1.0 endpoint. No agent-specific APIs.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  agent,
  methods,
  RequestError,
  PROTOCOL_VERSION,
  type ContentBlock,
  type StopReason,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { A2aClient, END_STATES, object, type A2aObject } from "./a2a.ts";
import { SessionFile, type A2aSession } from "./a2a-session.ts";
import { writeAtomic } from "./store.ts";

export interface AcpBridgeConfig {
  url: string;
  token: string;
  prefix: string;
  dir: string;
  timeoutSeconds: number;
  extensions?: string;
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
  app.onRequest(methods.agent.initialize, async ({ signal }) => {
    const api = client(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    try {
      card = await api.discover();
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
  app.onRequest(methods.agent.session.new, ({ params }) => {
    if (params.mcpServers.length)
      throw RequestError.invalidParams(
        "A2A agents do not accept client-provided MCP servers",
      );
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
    const session = { file: record, state, cwd: params.cwd, history: [] };
    saveHistory(session);
    sessions.set(id, session);
    return { sessionId: id };
  });
  app.onRequest(
    methods.agent.session.load,
    async ({ params, client: peer }) => {
      if (params.mcpServers.length)
        throw RequestError.invalidParams("MCP servers are not supported");
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
        return {};
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
    const session = find(params.sessionId);
    if (!session.active) return;
    session.active.cancelled = true;
    await cancelTask(session);
  });
  app.onRequest(
    methods.agent.session.prompt,
    async ({ params, signal, client: peer }) => {
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
      const turnId = randomUUID();
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
          // ACP tool-call updates can replace content; message chunks cannot. Preserve A2A append/replace semantics.
          const content = [
            {
              type: "content" as const,
              content: { type: "text" as const, text: partsText(value.parts) },
            },
          ];
          await notify(
            previous
              ? {
                  sessionUpdate: "tool_call_update",
                  toolCallId: `artifact:${turnId}:${id}`,
                  content,
                }
              : {
                  sessionUpdate: "tool_call",
                  toolCallId: `artifact:${turnId}:${id}`,
                  title: value.name,
                  kind: "other",
                  status: "in_progress",
                  content,
                },
          );
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
        for (const [id, value] of artifacts) {
          await notify({
            sessionUpdate: "tool_call_update",
            toolCallId: `artifact:${turnId}:${id}`,
            status: state === "TASK_STATE_FAILED" ? "failed" : "completed",
          });
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
