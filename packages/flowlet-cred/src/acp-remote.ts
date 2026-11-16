/** Flowlet's authenticated ACP session transport. It never delegates client tools. */
import { a2aEvents, a2aUrl, object, type A2aObject } from "./a2a.ts";

export const ACP_SESSION_EXTENSION = "urn:flowlet:acp-session:1";
export type AcpFrame =
  | { type: "update"; params: A2aObject }
  | { type: "permission"; requestId: string; params: A2aObject }
  | { type: "result"; result: A2aObject }
  | { type: "error"; code: number; message: string; data?: unknown };

export class RemoteAcp {
  private url: string;
  private token: string;
  constructor(endpoint: string, token: string) {
    this.url = a2aUrl(endpoint).href.replace(/\/$/, "") + "/acp";
    this.token = token;
  }
  async call(
    method: string,
    params: A2aObject,
    signal: AbortSignal,
    receive: (frame: AcpFrame) => Promise<void> = async () => {},
  ): Promise<A2aObject> {
    const response = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Remote ACP: HTTP ${response.status}`);
    }
    for await (const raw of a2aEvents(response.body)) {
      const frame = object(raw) as AcpFrame;
      if (frame.type === "result") return object(frame.result);
      if (frame.type === "error") {
        const error = new Error(frame.message) as Error & {
          code: number;
          data?: unknown;
        };
        error.code = frame.code;
        error.data = frame.data;
        throw error;
      }
      if (frame.type !== "update" && frame.type !== "permission")
        throw new Error("Invalid remote ACP frame");
      await receive(frame);
    }
    throw new Error(
      "Remote ACP stream ended before its result; request was not retried",
    );
  }
}
