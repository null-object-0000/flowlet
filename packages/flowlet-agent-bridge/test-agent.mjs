// Deterministic real stdio ACP fixture: no network, model or credentials.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const sessions = new Map();
const app = agent({ name: "fixture" });
app.onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } }));
app.onRequest(methods.agent.session.new, () => {
  const sessionId = randomUUID();
  sessions.set(sessionId, { count: 0 });
  return { sessionId };
});
app.onNotification(methods.agent.session.cancel, ({ params }) => sessions.get(params.sessionId)?.cancel?.());
app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  const session = sessions.get(params.sessionId);
  session.count++;
  const text = params.prompt.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  if (text === "hold") {
    await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } } });
    await new Promise((resolve) => { session.cancel = resolve; });
    return { stopReason: "cancelled" };
  }
  if (text === "permission") {
    const result = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "p1", title: "Read fixture", kind: "read", status: "pending" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }],
    });
    await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } } });
  } else {
    for (const chunk of [`第${session.count}轮：`, text]) await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } });
  }
  return { stopReason: "end_turn" };
});
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
