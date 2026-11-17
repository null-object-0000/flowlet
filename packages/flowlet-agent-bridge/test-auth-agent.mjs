// Deterministic ACP authentication fixture. Never contacts a real login service.
import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
const app = agent({ name: "auth-fixture" });
let authenticated = false;
const sessions = new Set();
app.onRequest(methods.agent.initialize, () => ({
  protocolVersion: 1,
  authMethods: [{ id: "personal", name: "Personal account" }],
  agentCapabilities: {
    auth: { logout: {} },
    loadSession: true,
    sessionCapabilities: { list: {} },
  },
}));
app.onRequest(methods.agent.authenticate, async ({ client, requestId }) => {
  const result = await client.request(methods.client.elicitation.create, {
    mode: "url",
    requestId: requestId ?? 0,
    elicitationId: randomUUID(),
    url: "https://fixture.example/login",
    message: "Sign in using your own account",
  });
  if (result.action !== "accept")
    throw new RequestError(-32000, "PRIVATE_AUTH_ERROR", {
      secret: "DO_NOT_CAPTURE",
    });
  authenticated = true;
  return { _meta: { secret: "DO_NOT_CAPTURE" } };
});
app.onRequest(methods.agent.logout, () => {
  authenticated = false;
  sessions.clear();
  return {};
});
const requireAuth = () => {
  if (!authenticated) throw new RequestError(-32000, "Sign in first");
};
app.onRequest(methods.agent.session.new, () => {
  requireAuth();
  const sessionId = randomUUID();
  sessions.add(sessionId);
  return { sessionId };
});
app.onRequest(methods.agent.session.load, ({ params }) => {
  requireAuth();
  if (!sessions.has(params.sessionId))
    throw RequestError.sessionNotFound(params.sessionId);
  return {};
});
app.onRequest(methods.agent.session.list, () => {
  requireAuth();
  return {
    sessions: [...sessions].map((sessionId) => ({
      sessionId,
      cwd: process.cwd(),
    })),
  };
});
const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
