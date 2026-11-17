// Version-specific ACP presentation over Flowlet's managed v1 transport. No agent-specific APIs.
import {
  client,
  methods,
  type AgentApp,
  type ClientContext,
} from "@agentclientprotocol/sdk";
import {
  agent,
  methods as v2,
  type AgentContext,
} from "@agentclientprotocol/sdk/experimental/v2";

const MANAGED = "urn:flowlet:managed-acp:1";
export function createAcpV2Bridge(source: AgentApp) {
  const app = agent({ name: "flowlet-managed" });
  let outer: AgentContext | undefined,
    closed = false,
    release!: () => void;
  const abort = new AbortController(),
    lifetime = new Promise<void>((r) => {
      release = r;
    });
  let readyResolve!: (peer: ClientContext) => void,
    readyReject!: (error: unknown) => void;
  const ready = new Promise<ClientContext>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const feeds = new Map<string, string>();
  let historyIndex = 0;
  const messageGroups = new Map<string, { role: string; id: string }>();
  const setup = (value: any) => ({
    ...value,
    ...(value.configOptions
      ? {
          configOptions: value.configOptions.map((o: any) => {
            const { id, ...rest } = o;
            return { ...rest, configId: id };
          }),
        }
      : {}),
  });
  async function send(sessionId: string, update: any) {
    if (!closed && outer)
      await outer.notify(v2.client.session.update, { sessionId, update });
  }
  const inner = client({ name: "flowlet-managed-v2" })
    .onNotification(methods.client.session.update, async ({ params }) => {
      let update: any = { ...params.update };
      if (update.sessionUpdate === "tool_call")
        update.sessionUpdate = "tool_call_update";
      if (
        [
          "user_message_chunk",
          "agent_message_chunk",
          "agent_thought_chunk",
        ].includes(update.sessionUpdate)
      ) {
        let group = messageGroups.get(params.sessionId);
        if (group?.role !== update.sessionUpdate) {
          group = {
            role: update.sessionUpdate,
            id: `history:${params.sessionId}:${historyIndex++}`,
          };
          messageGroups.set(params.sessionId, group);
        }
        update.messageId =
          update._meta?.[MANAGED]?.messageId ?? update.messageId ?? group!.id;
      } else if (update.sessionUpdate === "tool_call_update")
        messageGroups.delete(params.sessionId);
      if (update.sessionUpdate === "config_option_update")
        update = setup(update);
      if (
        [
          "tool_call_update",
          "user_message_chunk",
          "agent_message_chunk",
          "agent_thought_chunk",
          "config_option_update",
          "usage_update",
          "session_info_update",
        ].includes(update.sessionUpdate)
      )
        await send(params.sessionId, update);
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      if (!outer) throw new Error("Observer disconnected");
      const result = await outer.request(v2.client.session.requestPermission, {
        sessionId: params.sessionId,
        title: params.toolCall.title ?? "Permission requested",
        subject: {
          type: "tool_call",
          toolCall: {
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? "Tool",
            rawInput: params.toolCall.rawInput,
          },
        },
        options: params.options,
      });
      return result.outcome.outcome === "selected"
        ? {
            outcome: {
              outcome: "selected" as const,
              optionId: String((result.outcome as any).optionId),
            },
          }
        : { outcome: { outcome: "cancelled" as const } };
    });
  void inner
    .connectWith(source, async (peer) => {
      readyResolve(peer);
      await lifetime;
    })
    .catch(readyReject);
  async function call(method: string, params: any = {}) {
    const peer = await ready;
    return await peer.request<any>(method, params, {
      cancellationSignal: abort.signal,
      stopWaitingOnCancel: true,
    });
  }
  async function state(sessionId: string, meta: any) {
    await send(
      sessionId,
      meta?.state === "idle" || !meta?.runId
        ? {
            sessionUpdate: "state_update",
            state: "idle",
            ...(meta?.stopReason ? { stopReason: meta.stopReason } : {}),
          }
        : { sessionUpdate: "state_update", state: "running" },
    );
  }
  function follow(sessionId: string, meta: any) {
    if (
      !meta?.runId ||
      meta.state === "idle" ||
      feeds.get(sessionId) === meta.runId
    )
      return;
    feeds.set(sessionId, meta.runId);
    const heartbeat = setInterval(() => {
      void send(sessionId, {
        sessionUpdate: "state_update",
        state: "running",
      }).catch(() => {});
    }, 1000);
    void call("_flowlet/subscribe", {
      sessionId,
      runId: meta.runId,
      cursor: meta.cursor ?? 0,
    })
      .then(
        async (result) => {
          await send(sessionId, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: result.stopReason ?? "end_turn",
          });
        },
        async (error) => {
          if (!closed)
            await send(sessionId, {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "error",
              error: {
                code: Number(error.code) || -32603,
                message: error.message ?? "Managed subscription failed",
              },
            });
        },
      )
      .finally(() => {
        clearInterval(heartbeat);
        if (feeds.get(sessionId) === meta.runId) feeds.delete(sessionId);
      });
  }
  app.onRequest(v2.agent.initialize, async ({ params, client: peer }) => {
    outer = peer;
    const result = await call(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: !!params.capabilities?.auth?.terminal },
      },
    });
    if (!result._meta?.[MANAGED])
      throw new Error(
        "The Host does not support managed ACP sessions; update Flowlet",
      );
    return {
      protocolVersion: 2,
      info: result.agentInfo ?? { name: "flowlet", version: "0.2.0" },
      capabilities: {
        session: {
          prompt: {
            ...(result.agentCapabilities?.promptCapabilities?.image === true
              ? { image: {} }
              : {}),
          },
          ...(result.agentCapabilities?.sessionCapabilities?.delete
            ? { delete: {} }
            : {}),
        },
      },
      authMethods: (result.authMethods ?? []).map((m: any) => {
        const { id, ...rest } = m;
        return { ...rest, methodId: id, type: m.type ?? "agent" };
      }),
    };
  });
  app.onRequest(v2.agent.auth.login, async ({ params }) => {
    await call(methods.agent.authenticate, {
      methodId: params.methodId,
      ...(params._meta ? { _meta: params._meta } : {}),
    });
    return {};
  });
  app.onRequest(v2.agent.auth.logout, async () => {
    await call(methods.agent.logout, {});
    return {};
  });
  app.onRequest(v2.agent.session.new, async ({ params }) =>
    setup(
      await call(methods.agent.session.new, {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      }),
    ),
  );
  app.onRequest(
    v2.agent.session.list,
    async () => await call(methods.agent.session.list, {}),
  );
  app.onRequest(v2.agent.session.resume, async ({ params }) => {
    if (params.replayFrom && params.replayFrom.type !== "start")
      throw new Error("Unsupported replay cursor");
    historyIndex = 0;
    messageGroups.delete(params.sessionId);
    const result = await call(
      params.replayFrom
        ? methods.agent.session.load
        : methods.agent.session.resume,
      {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      },
    );
    if (params.replayFrom)
      await send(params.sessionId, { sessionUpdate: "replay_complete" });
    const meta = result._meta?.[MANAGED];
    await state(params.sessionId, meta);
    queueMicrotask(() => follow(params.sessionId, meta));
    return setup(result);
  });
  app.onRequest(v2.agent.session.setConfigOption, async ({ params }) =>
    setup(
      await call(methods.agent.session.setConfigOption, {
        sessionId: params.sessionId,
        configId: params.configId,
        value: (params as any).value,
      }),
    ),
  );
  app.onRequest(
    v2.agent.session.close,
    async ({ params }) => await call(methods.agent.session.close, params),
  );
  app.onRequest(
    v2.agent.session.delete,
    async ({ params }) => await call(methods.agent.session.delete, params),
  );
  app.onRequest(v2.agent.session.prompt, async ({ params }) => {
    const result = await call("_flowlet/start", {
      sessionId: params.sessionId,
      prompt: params.prompt,
    });
    const meta = result._meta?.[MANAGED];
    if (!meta?.messageId) throw new Error("Host did not accept the prompt");
    await state(params.sessionId, meta);
    queueMicrotask(() => follow(params.sessionId, { ...meta, cursor: 0 }));
    return { messageId: meta.messageId };
  });
  app.onNotification(v2.agent.session.cancel, async ({ params }) => {
    const peer = await ready;
    await peer.notify(methods.agent.session.cancel, params);
  });
  return {
    app,
    close() {
      closed = true;
      abort.abort();
      release();
    },
  };
}
