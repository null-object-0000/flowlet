// Deterministic real stdio ACP fixture: no network, model or credentials.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const app = agent({ name: "fixture" });
let clientCapabilities;
const options = (session) => [
  {
    id: "model",
    category: "model",
    name: "Model",
    type: "select",
    currentValue: session.model,
    options: [
      { value: "fixture-small", name: "Small" },
      { value: "fixture-large", name: "Large" },
    ],
  },
  {
    id: "mode",
    category: "mode",
    name: "Mode",
    type: "select",
    currentValue: "safe",
    options: [
      { value: "safe", name: "Safe" },
      { value: "bypass", name: "Bypass permissions" },
    ],
  },
];
app.onRequest(methods.agent.initialize, ({ params }) => {
  clientCapabilities = params.clientCapabilities;
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: {} },
  };
});
app.onRequest(methods.agent.session.new, ({ params }) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, { count: 0, model: "fixture-small", params });
  return { sessionId, configOptions: options(sessions.get(sessionId)) };
});
app.onRequest(methods.agent.session.load, ({ params }) => {
  if (!sessions.has(params.sessionId)) throw new Error("session missing");
  return { configOptions: options(sessions.get(params.sessionId)) };
});
app.onRequest(
  methods.agent.session.setConfigOption,
  async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (
      params.configId !== "model" ||
      !["fixture-small", "fixture-large"].includes(params.value)
    )
      throw RequestError.invalidParams("unknown model");
    session.model = params.value;
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: options(session),
      },
    });
    return { configOptions: options(session) };
  },
);
app.onNotification(methods.agent.session.cancel, ({ params }) =>
  sessions.get(params.sessionId)?.cancel?.(),
);
app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  const session = sessions.get(params.sessionId);
  session.count++;
  const text = params.prompt
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  if (text === "client-tools") {
    const denied = [];
    for (const [method, extra] of [
      ["fs/read_text_file", { path: "/tmp/flowlet-client-secret" }],
      [
        "terminal/create",
        { command: "touch", args: ["/tmp/flowlet-client-executed"] },
      ],
    ]) {
      try {
        await client.request(method, { sessionId: params.sessionId, ...extra });
      } catch {
        denied.push(method);
      }
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: JSON.stringify({
            denied,
            clientCapabilities,
            mcpServers: session.params.mcpServers,
            cwd: session.params.cwd,
          }),
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (text === "model") {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: session.model },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (text === "hold") {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "waiting" },
      },
    });
    await new Promise((resolve) => {
      session.cancel = resolve;
    });
    return { stopReason: "cancelled" };
  }
  if (text === "permission") {
    const result = await client.request(
      methods.client.session.requestPermission,
      {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "p1",
          title: "Read fixture",
          kind: "read",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(result) },
      },
    });
  } else {
    for (const chunk of [`第${session.count}轮：`, text])
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
  }
  return { stopReason: "end_turn" };
});
const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
