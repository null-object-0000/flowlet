import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  A2aClient,
  END_STATES,
  MAX_A2A_BYTES,
  a2aUrl,
  object,
  type A2aObject,
} from "./a2a.ts";
import { CredentialStore } from "./store.ts";
import { SessionFile, type A2aSession } from "./a2a-session.ts";

export const A2A_USAGE = `flowlet a2a — A2A 1.0 JSON-RPC + SSE 客户端

  flowlet a2a discover [--extended]
  flowlet a2a send "消息" [--session=NAME | --state=FILE] [--new | --context=ID]
                   [--task=ID] [--file=PATH ...] [--file-url=URL ...] [--media-type=MIME]
                   [--data=JSON] [--stdin] [--async | --stream] [--history-length=N]
  flowlet a2a tasks get|wait|cancel|subscribe [TASK_ID] [--session=NAME | --state=FILE]
  flowlet a2a tasks list [--context=ID] [--status=STATE] [--page-size=N] [--page-token=TOKEN]
                        [--history-length=N] [--include-artifacts] [--after=ISO_TIMESTAMP]
  flowlet a2a session show|clear --session=NAME [或 --state=FILE]
  flowlet a2a rpc METHOD [--params=JSON | --params-file=FILE（- 表示 stdin）]

公共选项：
  --profile=NAME       读取 FLOWLET_A2A_<NAME>_URL / _TOKEN；默认 FLOWLET_A2A_URL / _TOKEN
  --prefix=PREFIX      使用已有凭据环境前缀，与 --profile 互斥
  --timeout=SECONDS    整次命令超时，默认900秒（不自动重发消息）
  --poll-ms=N          等待任务的轮询间隔，默认500毫秒
  --card-url=URL       覆盖 Card URL，必须与配置地址同源
  --extensions=URIS   显式声明接受的 A2A 扩展，逗号分隔
  --insecure          显式忽略该实例的 TLS 证书校验
  --json              显式选择 JSON（普通命令默认 JSON；流式操作输出 NDJSON）

从 flowlet login / pull 同步后的本机凭据库直接读取；也接受同前缀的成对环境变量。
原始附件以标准 raw Part 发送，URL 附件以 url Part 发送，CLI 不下载 URL 附件。
续聊仅复用 contextId；--task 仅用于显式继续上游允许继续的任务。
任务失败/取消/暂停时 send 或 wait 退出2；超时、协议或网络错误退出1；中断不取消上游任务。
`;

const STRING_OPTIONS = [
  "profile",
  "prefix",
  "session",
  "state",
  "context",
  "task",
  "media-type",
  "data",
  "timeout",
  "poll-ms",
  "card-url",
  "extensions",
  "history-length",
  "status",
  "page-size",
  "page-token",
  "after",
  "params",
  "params-file",
] as const;
const BOOL_OPTIONS = [
  "new",
  "async",
  "stream",
  "stdin",
  "extended",
  "include-artifacts",
  "json",
] as const;
const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  flag: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${flag} 必须为${min}–${max}的整数`);
  return Number(value);
}
function parseJson(text: string): A2aObject {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("RPC params 必须为 JSON 对象");
  return value as A2aObject;
}
function boundedRead(file: string | number): Buffer {
  const fd = typeof file === "number" ? file : openSync(file, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const count = readSync(fd, chunk);
      if (!count) break;
      total += count;
      if (total > MAX_A2A_BYTES) throw new Error("输入超过4 MiB");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks);
  } finally {
    if (typeof file !== "number") closeSync(fd);
  }
}
async function output(value: unknown, ndjson = false): Promise<void> {
  const text = JSON.stringify(value, null, ndjson ? undefined : 2) + "\n";
  let onError: (error: Error) => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      onError = reject;
      process.stdout.once("error", onError);
      process.stdout.write(text, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } finally {
    process.stdout.off("error", onError);
  }
}

function taskExit(task: A2aObject): number {
  return object(task.status).state === "TASK_STATE_COMPLETED" ? 0 : 2;
}
function validTask(value: A2aObject): A2aObject {
  if (
    typeof value.id !== "string" ||
    typeof object(value.status).state !== "string"
  )
    throw new Error(
      "上游未返回有效的标准 Task（GetTask.result 应直接是 Task）",
    );
  return value;
}

export async function a2aCommand(args: string[]): Promise<number> {
  const options: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean; short?: string }
  > = {
    help: { type: "boolean", short: "h" },
    file: { type: "string", multiple: true },
    "file-url": { type: "string", multiple: true },
  };
  for (const name of STRING_OPTIONS) options[name] = { type: "string" };
  for (const name of BOOL_OPTIONS) options[name] = { type: "boolean" };
  const { values: v, positionals: p } = parseArgs({
    args,
    options,
    strict: true,
    allowPositionals: true,
  });
  if (v.help || !p.length) {
    process.stdout.write(A2A_USAGE);
    return 0;
  }
  const str = (key: string) =>
    typeof v[key] === "string" ? (v[key] as string) : undefined;
  const flag = (key: string) => v[key] === true;
  const verb = p[0],
    action = p[1];
  if (!["discover", "send", "tasks", "session", "rpc"].includes(verb))
    throw new Error("未知 A2A 子命令：" + verb);
  if (
    verb === "tasks" &&
    !["get", "wait", "cancel", "subscribe", "list"].includes(action)
  )
    throw new Error("tasks 需要 get|wait|cancel|subscribe|list");
  if (verb === "session" && !["show", "clear"].includes(action))
    throw new Error("session 需要 show|clear");
  if (verb === "tasks" && action === "list" && p.length > 2)
    throw new Error("tasks list 不接受任务 ID");
  for (const key of ["state", "context", "task"])
    if (str(key) !== undefined && !str(key)!.trim())
      throw new Error("--" + key + " 不能为空");
  if (
    p.length >
    (verb === "tasks"
      ? 3
      : verb === "send" || verb === "session" || verb === "rpc"
        ? 2
        : 1)
  )
    throw new Error("位置参数过多；消息含空格时请使用引号");
  if (flag("async") && flag("stream"))
    throw new Error("--async 与 --stream 互斥");
  if (
    flag("new") &&
    (str("context") !== undefined || str("task") !== undefined)
  )
    throw new Error("--new 与 --context/--task 互斥");
  if (str("session") !== undefined && str("state") !== undefined)
    throw new Error("--session 与 --state 互斥");
  if (str("profile") !== undefined && str("prefix") !== undefined)
    throw new Error("--profile 与 --prefix 互斥");
  const sendOnly = [
    "new",
    "async",
    "stdin",
    "task",
    "file",
    "file-url",
    "media-type",
  ];
  if (verb !== "send" && sendOnly.some((k) => v[k] !== undefined))
    throw new Error("消息和附件选项只能用于 send");
  if (verb !== "send" && flag("stream"))
    throw new Error(
      "--stream 只能用于 send；tasks subscribe 和流式 rpc 自动输出 NDJSON",
    );
  if (flag("extended") && verb !== "discover")
    throw new Error("--extended 只能用于 discover");
  if (
    (str("params") !== undefined || str("params-file") !== undefined) &&
    verb !== "rpc"
  )
    throw new Error("--params/--params-file 只能用于 rpc");
  if (str("data") !== undefined && verb !== "send")
    throw new Error("--data 只能用于 send；rpc 使用 --params");
  if (str("params") !== undefined && str("params-file") !== undefined)
    throw new Error("--params 与 --params-file 互斥");

  const profile = str("profile")?.toUpperCase();
  if (profile !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(profile))
    throw new Error("--profile 需为以字母开头的字母、数字或下划线");
  const prefix =
    str("prefix") ?? (profile ? "FLOWLET_A2A_" + profile : "FLOWLET_A2A");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(prefix))
    throw new Error("A2A 凭据前缀无效");
  const store = CredentialStore.fromDefaultDir();
  const urlKey = prefix + "_URL",
    tokenKey = prefix + "_TOKEN";
  const envUrl = process.env[urlKey],
    envToken = process.env[tokenKey];
  if ((envUrl !== undefined) !== (envToken !== undefined))
    throw new Error(
      `环境变量 ${urlKey}/${tokenKey} 必须成对提供，不能与凭据库混用`,
    );
  const url = (envUrl ?? store.get(urlKey))?.trim(),
    token = (envToken ?? store.get(tokenKey))?.trim();
  if (!url || !token)
    throw new Error(
      `缺少 ${urlKey}/${tokenKey}；请先 flowlet login / flowlet pull，或指定已有 --prefix`,
    );
  const configured = a2aUrl(url).href;
  const session =
    str("session") !== undefined || str("state") !== undefined
      ? new SessionFile(
          store.dir,
          configured,
          prefix,
          str("session"),
          str("state"),
        )
      : undefined;
  if (verb === "session") {
    if (!session) throw new Error("请指定 --session 或 --state");
    if (action === "show") {
      await output(session.read());
      return 0;
    }
    const unlock = session.lock();
    try {
      session.clear();
      await output({ cleared: true });
      return 0;
    } finally {
      unlock();
    }
  }
  const timeout = integer(str("timeout"), 900, 1, 3600, "--timeout");
  const poll = integer(str("poll-ms"), 500, 50, 60000, "--poll-ms");
  const history = integer(
    str("history-length"),
    0,
    0,
    1000,
    "--history-length",
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT"),
    terminate = () => controller.abort("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeout * 1000),
  ]);
  const client = new A2aClient(url, token, {
    signal,
    insecure: flag("insecure"),
    extensions: str("extensions"),
  });
  let unlock: (() => void) | undefined;
  try {
    let state: A2aSession | null = null;
    if (verb === "send") unlock = session?.lock();
    if (!flag("new")) state = session?.read() ?? null;
    const observe = (value: A2aObject) => {
      if (session && verb === "send") state = session.save(state, value);
    };
    await client.discover(str("card-url"));
    if (verb === "discover") {
      await output(
        flag("extended")
          ? await client.call("GetExtendedAgentCard")
          : client.card,
      );
      return 0;
    }
    const stream = async (
      method: string,
      params: A2aObject,
    ): Promise<number> => {
      let complete = false,
        lastState: string | undefined;
      for await (const event of client.stream(method, params)) {
        observe(event);
        const item = object(event.task ?? event.statusUpdate);
        const current = object(item.status).state;
        if (typeof current === "string") {
          lastState = current;
          if (END_STATES.has(current)) complete = true;
        }
        if (event.message) complete = true;
        await output(event, true);
      }
      if (!complete)
        throw new Error(
          "SSE 已结束但未观察到终态或暂停状态；请查询任务，未自动重发消息",
        );
      return lastState && lastState !== "TASK_STATE_COMPLETED" ? 2 : 0;
    };
    if (verb === "send") {
      if (p[1] !== undefined && flag("stdin"))
        throw new Error("消息位置参数与 --stdin 互斥");
      const text = flag("stdin") ? boundedRead(0).toString("utf8") : p[1];
      const parts: A2aObject[] = [];
      if (text) parts.push({ text });
      if (str("data") !== undefined)
        parts.push({ data: JSON.parse(str("data")!) });
      const files = Array.isArray(v.file) ? (v.file as string[]) : [];
      const urls = Array.isArray(v["file-url"])
        ? (v["file-url"] as string[])
        : [];
      if (str("media-type") && files.length + urls.length !== 1)
        throw new Error("--media-type 只用于恰好一个文件附件");
      const media = (name: string) =>
        str("media-type") ??
        MIME[path.extname(name).toLowerCase()] ??
        "application/octet-stream";
      for (const file of files) {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_A2A_BYTES)
          throw new Error("附件需为不超过4 MiB的普通文件：" + file);
        parts.push({
          raw: boundedRead(file).toString("base64"),
          filename: path.basename(file),
          mediaType: media(file),
        });
      }
      for (const raw of urls) {
        const url = new URL(raw);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error("附件 URL 需为不含账号或锚点的 HTTP(S) 地址");
        parts.push({
          url: raw,
          filename: path.posix.basename(url.pathname) || "attachment",
          mediaType: media(url.pathname),
        });
      }
      if (!parts.length) throw new Error("请提供消息、--stdin、--data 或附件");
      const context = str("context") ?? state?.contextId;
      const message: A2aObject = {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts,
        ...(context ? { contextId: context } : {}),
        ...(str("task") ? { taskId: str("task") } : {}),
      };
      const params = {
        message,
        configuration: { returnImmediately: true, historyLength: history },
      };
      if (flag("stream")) return await stream("SendStreamingMessage", params);
      let result = await client.call("SendMessage", params);
      if ((result.task === undefined) === (result.message === undefined))
        throw new Error("SendMessage 必须返回 task 或 message 中的一种");
      if (result.task) validTask(object(result.task));
      observe(result);
      if (result.task && !flag("async"))
        result = {
          task: await client.wait(
            validTask(object(result.task)),
            history,
            poll,
            observe,
          ),
        };
      await output(result);
      return result.task &&
        END_STATES.has(String(object(object(result.task).status).state))
        ? taskExit(object(result.task))
        : 0;
    }
    if (verb === "rpc") {
      if (!action) throw new Error("rpc 需要标准方法名");
      const raw =
        str("params-file") !== undefined
          ? boundedRead(
              str("params-file") === "-" ? 0 : str("params-file")!,
            ).toString("utf8")
          : (str("params") ?? "{}");
      const params = parseJson(raw);
      if (["SendStreamingMessage", "SubscribeToTask"].includes(action))
        return await stream(action, params);
      await output(await client.call(action, params));
      return 0;
    }
    if (action === "list") {
      const params: A2aObject = {
        pageSize: integer(str("page-size"), 50, 1, 100, "--page-size"),
        historyLength: history,
      };
      for (const [option, field] of [
        ["context", "contextId"],
        ["status", "status"],
        ["page-token", "pageToken"],
        ["after", "statusTimestampAfter"],
      ])
        if (str(option) !== undefined) params[field] = str(option);
      if (flag("include-artifacts")) params.includeArtifacts = true;
      await output(await client.call("ListTasks", params));
      return 0;
    }
    const id = p[2] ?? state?.taskId;
    if (!id)
      throw new Error("请提供 TASK_ID，或指定已有任务的 --session / --state");
    if (action === "subscribe") return await stream("SubscribeToTask", { id });
    if (action === "cancel") {
      await output(await client.call("CancelTask", { id }));
      return 0;
    }
    let task = validTask(
      await client.call("GetTask", { id, historyLength: history }),
    );
    if (action === "wait")
      task = await client.wait(task, history, poll, () => {});
    await output(task);
    return action === "wait" ? taskExit(task) : 0;
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(
        "调用已中断；上游任务未自动取消，请使用 tasks get 查询\n",
      );
      return controller.signal.reason === "SIGTERM" ? 143 : 130;
    }
    if (signal.aborted)
      throw new Error(
        "A2A 等待超时；任务可能继续执行，请使用 tasks get 查询，未自动重发消息",
      );
    throw new Error(client.clean(error));
  } finally {
    unlock?.();
    await client.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
