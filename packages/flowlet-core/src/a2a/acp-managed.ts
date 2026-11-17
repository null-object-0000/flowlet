import { randomUUID } from "node:crypto";
import type { AcpFrame } from "../../../flowlet-cred/src/acp-remote.ts";
import { nativePrompt } from "../../../flowlet-cred/src/acp-prompt.ts";
import { asObject as object, type JsonObject } from "./protocol.ts";

export const MANAGED = "urn:flowlet:managed-acp:1";
type Emit = (frame: AcpFrame) => Promise<void>;
type Direct = (
  method: string,
  params: JsonObject,
  signal: AbortSignal,
  emit: Emit,
) => Promise<JsonObject>;
type Cache = {
  config: JsonObject;
  history: AcpFrame[];
  bytes: number;
  complete: boolean;
  run?: Turn;
};
type Turn = {
  id: string;
  messageId: string;
  state: string;
  controller: AbortController;
  events: AcpFrame[];
  bytes: number;
  listeners: Set<() => void>;
  permissions: Map<string, AcpFrame>;
  subscribers: number;
  done: boolean;
  result?: JsonObject;
  error?: Error & { code?: number };
};

/** A task belongs to its native runtime, never to one HTTP subscriber. No prompt retries. */
export class ManagedAcp {
  private sessions = new Map<string, Cache>();
  private starting = new Set<string>();
  private init: JsonObject = {};
  private direct: Direct;
  private timeout: number;
  private track: (
    sessionId: string,
    controller: AbortController,
    done: Promise<JsonObject>,
  ) => void;
  constructor(
    direct: Direct,
    timeout: number,
    track: (
      sessionId: string,
      controller: AbortController,
      done: Promise<JsonObject>,
    ) => void = () => {},
  ) {
    this.direct = direct;
    this.timeout = timeout;
    this.track = track;
  }
  private meta(cache: Cache) {
    const r = cache.run;
    return r
      ? {
          runId: r.id,
          messageId: r.messageId,
          cursor: r.events.length,
          state: r.state,
          ...(r.done ? { stopReason: r.result?.stopReason ?? "error" } : {}),
        }
      : { state: "idle" };
  }
  private result(cache: Cache) {
    return {
      ...cache.config,
      _meta: { ...object(cache.config._meta), [MANAGED]: this.meta(cache) },
    };
  }
  private history(cache: Cache, frame: AcpFrame) {
    if (frame.type !== "update") return;
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (cache.bytes + size > 8 * 1024 * 1024) {
      cache.history = [];
      cache.bytes = 0;
      cache.complete = false;
    }
    cache.history.push(frame);
    cache.bytes += size;
  }
  private retainedBytes() {
    return [...this.sessions.values()].reduce(
      (n, c) => n + c.bytes + (c.run?.bytes ?? 0),
      0,
    );
  }
  private trim(keep: Cache) {
    for (const [key, c] of this.sessions) {
      if (this.retainedBytes() <= 32 * 1024 * 1024) break;
      if (c !== keep && (!c.run || c.run.done)) this.sessions.delete(key);
    }
  }
  private push(cache: Cache, run: Turn, frame: AcpFrame) {
    if (run.done) return;
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (
      run.bytes + size > 8 * 1024 * 1024 ||
      run.events.length >= 20000 ||
      this.retainedBytes() + size * 2 > 32 * 1024 * 1024
    ) {
      run.controller.abort(new Error("ACP retained event limit reached"));
      return;
    }
    run.events.push(frame);
    run.bytes += size;
    if (frame.type === "permission") {
      run.permissions.set(frame.requestId, frame);
      run.state = "waiting";
    }
    this.history(cache, frame);
    if (
      frame.type === "update" &&
      object(frame.params.update).sessionUpdate === "config_option_update"
    )
      cache.config.configOptions = object(frame.params.update).configOptions;
    for (const wake of run.listeners) wake();
  }
  private async subscribe(
    cache: Cache,
    raw: JsonObject,
    signal: AbortSignal,
    emit: Emit,
  ) {
    const run = cache.run;
    if (!run || raw.runId !== run.id)
      throw Object.assign(
        new Error("Managed ACP run no longer exists; reload the session"),
        { code: -32602 },
      );
    let cursor = Number(raw.cursor ?? 0);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > run.events.length
    )
      throw Object.assign(new Error("Invalid managed event cursor"), {
        code: -32602,
      });
    if (run.subscribers >= 8)
      throw new Error("Managed ACP subscriber limit reached");
    run.subscribers++;
    try {
      // A pending question predating the cursor must still be presented after reconnect.
      for (const frame of run.permissions.values())
        if (run.events.indexOf(frame) < cursor) await emit(frame);
      for (;;) {
        signal.throwIfAborted();
        while (cursor < run.events.length) {
          const frame = run.events[cursor++];
          if (
            frame.type === "permission" &&
            !run.permissions.has(frame.requestId)
          )
            continue;
          await emit(frame);
          signal.throwIfAborted();
        }
        if (run.done) {
          if (run.error) throw run.error;
          return run.result ?? {};
        }
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            run.listeners.delete(wake);
            signal.removeEventListener("abort", abort);
          };
          const wake = () => {
            done();
            resolve();
          };
          const abort = () => {
            done();
            reject(signal.reason);
          };
          run.listeners.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else if (cursor < run.events.length || run.done) wake();
        });
      }
    } finally {
      run.subscribers--;
    }
  }
  async call(
    method: string,
    raw: JsonObject,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<JsonObject> {
    const id = String(raw.sessionId ?? "");
    let cache = this.sessions.get(id);
    if (method === "initialize") {
      this.init = await this.direct(method, raw, signal, emit);
      return {
        ...this.init,
        _meta: { ...object(this.init._meta), [MANAGED]: { version: 1 } },
      };
    }
    if (method === "session/status")
      return cache
        ? this.result(cache)
        : { _meta: { [MANAGED]: { state: "unknown" } } };
    if (method === "session/subscribe") {
      if (!cache) throw new Error("Managed session not found");
      return this.subscribe(cache, raw, signal, emit);
    }
    if (
      (method === "authenticate" || method === "logout") &&
      [...this.sessions.values()].some((c) => c.run && !c.run.done)
    )
      throw Object.assign(
        new Error("Finish background work before changing identity"),
        { code: -32600 },
      );
    if (method === "permission/reply") {
      const result = await this.direct(method, raw, signal, emit);
      cache?.run?.permissions.delete(String(raw.requestId));
      if (cache?.run) cache.run.state = "running";
      return result;
    }
    if (method === "session/close" && cache?.run && !cache.run.done) return {};
    if (
      method === "session/set_config_option" &&
      cache?.run &&
      !cache.run.done
    ) {
      const options = Array.isArray(cache.config.configOptions)
        ? cache.config.configOptions
        : [];
      if (
        options.some(
          (o) =>
            object(o).id === raw.configId &&
            object(o).currentValue === raw.value,
        )
      )
        return this.result(cache);
      throw Object.assign(
        new Error("Finish background work before changing model configuration"),
        { code: -32600 },
      );
    }
    if (
      (method === "session/load" || method === "session/resume") &&
      cache?.run &&
      (!cache.run.done || cache.complete)
    ) {
      if (method === "session/load") {
        if (!cache.complete)
          throw new Error(
            "Retained history exceeded its limit; attach with session/resume",
          );
        const history = [...cache.history],
          result = this.result(cache);
        for (const frame of history) await emit(frame);
        return result;
      }
      return this.result(cache);
    }
    if (method === "session/start" || method === "session/prompt") {
      raw = {
        ...raw,
        prompt: nativePrompt(
          raw.prompt,
          object(object(this.init.agentCapabilities).promptCapabilities)
            .image === true,
        ) as unknown as JsonObject[],
      };
      if (this.starting.has(id) || (cache?.run && !cache.run.done))
        throw Object.assign(
          new Error(
            "Session has a running background turn; reconnect instead of resending",
          ),
          { code: -32600 },
        );
      this.starting.add(id);
      try {
        if (!cache?.complete) {
          const snapshot: Cache = {
            config: {},
            history: [],
            bytes: 0,
            complete: true,
          };
          snapshot.config = await this.direct(
            "session/load",
            { sessionId: id },
            signal,
            async (frame) => {
              this.history(snapshot, frame);
            },
          );
          cache = snapshot;
          this.sessions.set(id, cache);
        }
        this.trim(cache);
        if (this.retainedBytes() > 32 * 1024 * 1024)
          throw new Error("Managed ACP memory limit reached");
        const run: Turn = {
          id: randomUUID(),
          messageId: randomUUID(),
          state: "running",
          controller: new AbortController(),
          events: [],
          bytes: 0,
          listeners: new Set(),
          permissions: new Map(),
          subscribers: 0,
          done: false,
        };
        cache.run = run;
        const current = cache;
        for (const content of Array.isArray(raw.prompt) ? raw.prompt : [])
          this.push(cache, run, {
            type: "update",
            params: {
              sessionId: id,
              update: {
                sessionUpdate: "user_message_chunk",
                content,
                _meta: {
                  [MANAGED]: { messageId: run.messageId, runId: run.id },
                },
              },
            },
          });
        const initialCursor = run.events.length;
        const execution = (async () => {
          const timer = setTimeout(
            () =>
              run.controller.abort(new Error("Background ACP task timed out")),
            this.timeout * 1000,
          );
          try {
            const result = await this.direct(
              "session/prompt",
              raw,
              run.controller.signal,
              async (frame) => {
                if (frame.type === "update") {
                  const update = object(frame.params.update),
                    kind = String(update.sessionUpdate);
                  frame = {
                    ...frame,
                    params: {
                      ...frame.params,
                      update: {
                        ...update,
                        _meta: {
                          ...object(update._meta),
                          [MANAGED]: {
                            runId: run.id,
                            messageId:
                              kind === "agent_thought_chunk"
                                ? `${run.id}:thought`
                                : `${run.id}:assistant`,
                          },
                        },
                      },
                    },
                  };
                }
                this.push(current, run, frame);
              },
            );
            run.result = result;
            run.state = "idle";
            return result;
          } catch (error) {
            run.error = Object.assign(
              new Error(
                error instanceof Error
                  ? error.message
                  : "Background ACP failed",
              ),
              { code: Number(object(error).code) || -32603 },
            );
            run.state = "idle";
            throw run.error;
          } finally {
            clearTimeout(timer);
            run.done = true;
            for (const wake of run.listeners) wake();
          }
        })();
        this.track(id, run.controller, execution);
        void execution.catch(() => {});
        if (method === "session/start") return this.result(cache);
        return await this.subscribe(
          cache,
          { runId: run.id, cursor: initialCursor },
          signal,
          emit,
        );
      } finally {
        this.starting.delete(id);
      }
    }
    const snapshot: Cache = {
      config: {},
      history: [],
      bytes: 0,
      complete: true,
    };
    const result = await this.direct(method, raw, signal, async (frame) => {
      if (method === "session/load") this.history(snapshot, frame);
      await emit(frame);
    });
    if (method === "authenticate" || method === "logout") this.sessions.clear();
    if (method === "session/new")
      this.sessions.set(String(result.sessionId), {
        config: result,
        history: [],
        bytes: 0,
        complete: true,
      });
    if (method === "session/load") {
      snapshot.config = result;
      cache = snapshot;
      this.sessions.set(id, cache);
      this.trim(cache);
    } else if (
      method === "session/resume" ||
      method === "session/set_config_option"
    ) {
      cache ??= { config: result, history: [], bytes: 0, complete: false };
      cache.config = result;
      this.sessions.set(id, cache);
    }
    if (method === "session/delete") this.sessions.delete(id);
    return cache && (method === "session/load" || method === "session/resume")
      ? this.result(cache)
      : result;
  }
}
