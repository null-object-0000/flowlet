// Agent 可选扩展 / 受管插件的内嵌源码（与 Rust `include_str!` 等价）。
//
// 来源：`src-tauri/resources/agent-plugins/**` 与 Adapter 内的受管常量；桌面版打包后
// 不能依赖仓库资源文件，因此编译进 Node 代码。修改上游资源时必须同步本文件。

/** OpenCode 权限事件插件（~/.config/opencode/plugins/flowlet.ts）。 */
export const OPENCODE_PERMISSION_PLUGIN_SOURCE: string = `// Flowlet 自动写入：桥接 OpenCode 进程内待确认权限状态。
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

export const FlowletPermissionBridge = async ({ client, serverUrl, directory, worktree }) => {
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return {}
  const root = path.join(home, ".flowlet", "opencode-control")
  const instanceKey = createHash("sha256")
    .update(String(directory || worktree || serverUrl))
    .digest("hex")
    .slice(0, 12)
  const statePath = path.join(root, \`state-\${process.pid}-\${instanceKey}.json\`)
  const stateTempPath = \`\${statePath}.tmp\`
  const permissions = new Map()
  const normalizePermission = (value) => ({
    id: value.id,
    sessionID: value.sessionID,
    permission: value.permission || value.type || "unknown",
    patterns: value.patterns || (Array.isArray(value.pattern) ? value.pattern : value.pattern ? [value.pattern] : []),
    metadata: value.metadata || {},
    always: value.always || [],
    tool: value.tool || (value.messageID ? { messageID: value.messageID, callID: value.callID || "" } : undefined),
  })

  await mkdir(root, { recursive: true })
  try {
    const response = await client.permission?.list?.()
    const pending = Array.isArray(response) ? response : response?.data
    if (Array.isArray(pending)) {
      for (const value of pending) permissions.set(value.id, normalizePermission(value))
    }
  } catch {}
  let persistQueue = Promise.resolve()
  const persist = () => {
    const snapshot = JSON.stringify({
      pid: process.pid,
      serverUrl: String(serverUrl),
      updatedAt: Date.now(),
      permissions: [...permissions.values()],
    })
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await writeFile(stateTempPath, snapshot, "utf8")
      await rename(stateTempPath, statePath)
    })
    return persistQueue
  }
  await persist()
  const consumeReplies = async () => {
    for (const name of await readdir(root)) {
      if (!name.startsWith("reply-") || !name.endsWith(".json")) continue
      const replyPath = path.join(root, name)
      try {
        const command = JSON.parse(await readFile(replyPath, "utf8"))
        const permission = permissions.get(command.permissionId)
        if (!permission) continue
        if (client.permission?.reply) {
          await client.permission.reply({ requestID: command.permissionId, reply: command.reply })
        } else if (client.postSessionIdPermissionsPermissionId) {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: permission.sessionID, permissionID: command.permissionId },
            body: { response: command.reply },
          })
        } else {
          throw new Error("当前 OpenCode SDK 不支持 permission.reply")
        }
        await unlink(replyPath)
      } catch {}
    }
  }
  const heartbeat = setInterval(() => {
    void persist()
    void consumeReplies()
  }, 500)

  return {
    event: async ({ event }) => {
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        permissions.set(event.properties.id, normalizePermission(event.properties))
        await persist()
      } else if (event.type === "permission.replied") {
        permissions.delete(event.properties.requestID || event.properties.permissionID)
        await persist()
      }
    },
    dispose: async () => {
      clearInterval(heartbeat)
      await persistQueue.catch(() => {})
      try { await unlink(statePath) } catch {}
      try { await unlink(stateTempPath) } catch {}
    },
  }
}
`;

/** Pi 会话扩展（~/.pi/agent/extensions/flowlet.ts）。 */
export const PI_SESSION_EXTENSION_SOURCE: string = `// Flowlet 自动写入：为 Pi 请求注入会话标识，使 Flowlet 能按会话归属请求。
// 该扩展在每次 LLM 请求 headers 组装完成后，检测是否发往 Flowlet 渠道
// （x-flowlet-client: pi），若是则注入 x-flowlet-session 头，值为当前会话 UUID
// （与 ~/.pi/agent/sessions/ 下会话文件头行的 id 一致）。该头仅用于本地归属，
// Flowlet 在转发上游前会将其剥离，不参与鉴权或路由。
export default function (pi) {
  pi.on("before_provider_headers", (event, ctx) => {
    if (event.headers?.["x-flowlet-client"] !== "pi") return;
    try {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (typeof sessionId === "string" && sessionId.length > 0) {
        event.headers["x-flowlet-session"] = sessionId;
      }
    } catch {
      // 忽略：无法获取会话 id 时不阻塞请求。
    }
  });
}
`;

/** DeepSeek Harness 受管会话桥（Profile 内 .flowlet/flowlet-session-bridge.mjs）。 */
export const DSH_SESSION_BRIDGE_SOURCE: string = `import { AsyncLocalStorage } from "node:async_hooks";

const SESSION_HEADER = "x-flowlet-session";
const sessions = new AsyncLocalStorage();

function normalizedBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function matchesBaseUrl(input, baseUrl) {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if (url.origin !== baseUrl.origin) return false;
    const basePath = baseUrl.pathname;
    return url.pathname === basePath || url.pathname.startsWith(\`\${basePath}/\`);
  } catch {
    return false;
  }
}

function withSessionHeader(input, init, sessionId) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(SESSION_HEADER, sessionId);
  if (input instanceof Request) {
    return [new Request(input, { ...init, headers }), undefined];
  }
  return [input, { ...init, headers }];
}

async function* withinSession(next, context) {
  const iterable = sessions.run(context, next);
  const iterator = iterable[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const item = await sessions.run(context, () => iterator.next());
      if (item.done) {
        completed = true;
        return;
      }
      yield item.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await sessions.run(context, () => iterator.return());
    }
  }
}

export const inject = ["llm"];

export default function apply(ctx, config = {}) {
  const provider = config.provider ?? "flowlet";
  const baseUrl = normalizedBaseUrl(config.baseURL);
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("Flowlet session bridge requires global fetch");
  }

  const wrappedFetch = function (input, init) {
    const context = sessions.getStore();
    if (!context || !matchesBaseUrl(input, context.baseUrl)) {
      return originalFetch.call(this, input, init);
    }
    const [nextInput, nextInit] = withSessionHeader(
      input,
      init,
      context.sessionId,
    );
    return originalFetch.call(this, nextInput, nextInit);
  };
  globalThis.fetch = wrappedFetch;
  ctx.effect(() => () => {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
  });

  ctx.on("llm/stream", (options, next) => {
    if (options.provider !== provider || !options.sessionId) return next();
    return withinSession(next, {
      sessionId: String(options.sessionId),
      baseUrl,
    });
  });
}
`;

/** Hermes 受管插件清单（plugins/flowlet-session-bridge/plugin.yaml）。 */
export const HERMES_SESSION_BRIDGE_MANIFEST: string = `name: flowlet-session-bridge
version: "1.0.0"
description: "Flowlet 精确会话关联桥 — 为发往 Flowlet 本地代理的 LLM 请求注入 x-flowlet-session 头，使 Flowlet 能按会话关联请求与用量。由 Flowlet 桌面端受管写入。"
author: Flowlet
kind: standalone
`;

/** Hermes 受管插件源码（plugins/flowlet-session-bridge/__init__.py）。 */
export const HERMES_SESSION_BRIDGE_SOURCE: string = `"""Flowlet 精确会话关联桥 — 为发往 Flowlet 本地代理的请求注入 x-flowlet-session 头。

Hermes 复用 OpenAI Python SDK，原生请求不携带会话标识，Flowlet 无法把请求按会话
归并到 Hermes 原生会话（state.db）。本插件注册 \`\`llm_request\`\` 中间件：仅当请求
发往 Flowlet 本地代理（携带 \`\`x-flowlet-client: hermes\`\` 标记头）时，把当前 Hermes
会话 id（\`\`sessions.id\`\`）注入 \`\`x-flowlet-session\`\` 头；Flowlet 识别后按
\`\`(agent_type, session_id)\`\` 精确关联，并在转发上游前剥离该头。

该插件由 Flowlet 桌面端受管写入，不修改 Hermes 可执行文件或内置资源；关闭选项后
由 Flowlet 移除。
"""

from __future__ import annotations

FLOWLET_MARKER_HEADER = "x-flowlet-client"
HERMES_MARKER = "hermes"
FLOWLET_SESSION_HEADER = "x-flowlet-session"


def register(ctx) -> None:
    """Hermes 插件入口：注册 LLM 请求中间件。"""
    ctx.register_middleware("llm_request", _inject_flowlet_session)


def _inject_flowlet_session(request, original_request=None, **context):
    """LLM 请求中间件：发往 Flowlet 时注入当前会话 id。

    仅当请求已携带 Flowlet 标记头（说明走 Flowlet 本地代理）才注入，避免污染
    其它 Provider；\`\`session_id\`\` 来自中间件上下文（Hermes 当前会话 id，与
    state.db 的 \`\`sessions.id\`\` 一致）。
    """
    if not isinstance(request, dict):
        return None
    headers = request.get("extra_headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    if headers.get(FLOWLET_MARKER_HEADER) != HERMES_MARKER:
        return None
    session_id = context.get("session_id")
    if not session_id:
        return None
    session_id = str(session_id).strip()
    if not session_id:
        return None
    updated_headers = dict(headers)
    updated_headers[FLOWLET_SESSION_HEADER] = session_id
    updated_request = dict(request)
    updated_request["extra_headers"] = updated_headers
    return {"request": updated_request}
`;
