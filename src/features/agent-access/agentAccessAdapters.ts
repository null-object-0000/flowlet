import codexModelCatalog from "../../../codex-models.json";
import type { AgentGlobalConfigOptions, AgentGlobalConfigReport, AgentSurface } from "../../domains/agent/types";
import type { AgentGlobalConfigAdapterId } from "../../domains/pluginRegistry";

export type Translate = (source: string, values?: Record<string, string | number>) => string;

export type ManualSnippet = {
  label: string;
  displayValue: string;
  copyValue: string;
};

export type AgentAccessContext = {
  endpoint: string;
  token: string;
  displayedToken: string;
  globalConfig?: AgentGlobalConfigReport;
  t: Translate;
};

export type AgentConfigStatus = { label: string; value: string };

export type AgentConfigControl = {
  id: string;
  label: string;
  descriptions: string[];
  checked: boolean;
  applyOptions: (checked: boolean) => AgentGlobalConfigOptions;
};

export type AgentAccessAdapter = {
  id: AgentGlobalConfigAdapterId;
  installationName: (surface: AgentSurface | undefined) => string;
  configStatuses: (context: AgentAccessContext) => AgentConfigStatus[];
  configControls: (context: AgentAccessContext) => AgentConfigControl[];
  applyOptions: (context: AgentAccessContext) => AgentGlobalConfigOptions | undefined;
  manualSnippets: (context: AgentAccessContext) => ManualSnippet[];
};

const OPENCODE_PERMISSION_PLUGIN_SNIPPET = `// 保存为 ~/.config/opencode/plugins/flowlet.ts
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

const PI_SESSION_EXTENSION = [
  "// 保存为 ~/.pi/agent/extensions/flowlet.ts，Pi 启动时自动加载（无需编译）。",
  "// 作用：为发往 Flowlet 渠道的请求注入 x-flowlet-session 头（值为当前会话 UUID），",
  "// 使 Flowlet 能按会话归并请求；该头仅用于本地归属，Flowlet 转发上游前会将其剥离。",
  "export default function (pi) {",
  '  pi.on("before_provider_headers", (event, ctx) => {',
  '    if (event.headers?.["x-flowlet-client"] !== "pi") return;',
  "    try {",
  "      const sessionId = ctx?.sessionManager?.getSessionId?.();",
  '      if (typeof sessionId === "string" && sessionId.length > 0) {',
  '        event.headers["x-flowlet-session"] = sessionId;',
  "      }",
  "    } catch {}",
  "  });",
  "}",
  "",
].join("\n");

const CODEX_MODEL_CATALOG_JSON = JSON.stringify(codexModelCatalog, null, 2);

function credentialsSnippet(token: string, type: "api" | "api_key") {
  return JSON.stringify({ flowlet: { type, key: token } }, null, 2);
}

const claudeCodeAdapter: AgentAccessAdapter = {
  id: "claude-code",
  installationName: () => "Claude Code",
  configStatuses: () => [],
  configControls: ({ globalConfig, t }) => {
    const primaryLongContext = globalConfig?.primary_long_context ?? false;
    const fastLongContext = globalConfig?.fast_long_context ?? false;
    return [
      {
        id: "primary-long-context",
        label: t("flowlet-pro 1M 长上下文"),
        descriptions: [t("用于 Claude Code 主会话及 Opus、Sonnet、Fable 模型映射。"), t("仅当 flowlet-pro 的所有启用路由都支持 1M 时开启。")],
        checked: primaryLongContext,
        applyOptions: (checked) => ({ primaryLongContext: checked, fastLongContext }),
      },
      {
        id: "fast-long-context",
        label: t("flowlet-flash 1M 长上下文"),
        descriptions: [t("用于 Haiku、快速后台任务和子 Agent 模型映射。"), t("仅当 flowlet-flash 的所有启用路由都支持 1M 时开启。")],
        checked: fastLongContext,
        applyOptions: (checked) => ({ primaryLongContext, fastLongContext: checked }),
      },
    ];
  },
  applyOptions: ({ globalConfig }) => ({
    primaryLongContext: globalConfig?.primary_long_context ?? false,
    fastLongContext: globalConfig?.fast_long_context ?? false,
  }),
  manualSnippets: ({ endpoint, token, displayedToken, globalConfig, t }) => {
    const primaryModel = globalConfig?.primary_long_context ? "flowlet-pro[1m]" : "flowlet-pro";
    const fastModel = globalConfig?.fast_long_context ? "flowlet-flash[1m]" : "flowlet-flash";
    const value = (authToken: string) => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_FABLE_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel,
        ANTHROPIC_SMALL_FAST_MODEL: fastModel,
        CLAUDE_CODE_SUBAGENT_MODEL: fastModel,
      },
    }, null, 2);
    return [{ label: t("settings.json 配置片段"), displayValue: value(displayedToken), copyValue: value(token) }];
  },
};

const openCodeAdapter: AgentAccessAdapter = {
  id: "opencode",
  installationName: (surface) => surface === "desktop" ? "OpenCode Desktop" : "OpenCode CLI",
  configStatuses: ({ globalConfig, t }) => [{
    label: t("权限插件"),
    value: t(globalConfig?.opencode_permission_bridge ? "已安装" : "需安装或更新"),
  }],
  configControls: () => [],
  applyOptions: () => undefined,
  manualSnippets: ({ endpoint, token, displayedToken, t }) => {
    const provider = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "flowlet/flowlet-pro",
      small_model: "flowlet/flowlet-flash",
      provider: { flowlet: { name: "Flowlet", npm: "@ai-sdk/openai-compatible", options: { baseURL: endpoint }, models: { "flowlet-pro": { name: "flowlet-pro" }, "flowlet-flash": { name: "flowlet-flash" } } } },
    }, null, 2);
    return [
      { label: t("opencode.jsonc 配置片段"), displayValue: provider, copyValue: provider },
      { label: t("auth.json 凭据片段"), displayValue: credentialsSnippet(displayedToken, "api"), copyValue: credentialsSnippet(token, "api") },
      { label: t("权限事件插件片段（flowlet.ts）"), displayValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET, copyValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET },
    ];
  },
};

const piAdapter: AgentAccessAdapter = {
  id: "pi",
  installationName: () => "Pi CLI",
  configStatuses: () => [],
  configControls: ({ globalConfig, t }) => [{
    id: "session-extension",
    label: t("会话扩展"),
    descriptions: [t("安装后可为请求注入会话标识，Flowlet 按会话归并请求；未安装则无法做会话维度串联。"), t("Pi 仍可作为 Flowlet 客户端使用，仅会话维度数据不可用。")],
    checked: globalConfig?.session_extension ?? true,
    applyOptions: (checked) => ({ sessionExtension: checked }),
  }],
  applyOptions: ({ globalConfig }) => ({ sessionExtension: globalConfig?.session_extension ?? true }),
  manualSnippets: ({ endpoint, token, displayedToken, t }) => {
    const models = JSON.stringify({ providers: { flowlet: { baseUrl: endpoint, api: "openai-completions", headers: { "x-flowlet-client": "pi" }, models: [{ id: "flowlet-pro", name: "flowlet-pro" }, { id: "flowlet-flash", name: "flowlet-flash" }] } } }, null, 2);
    const defaults = JSON.stringify({ defaultProvider: "flowlet", defaultModel: "flowlet-pro" }, null, 2);
    return [
      { label: t("models.json Provider 片段"), displayValue: models, copyValue: models },
      { label: t("auth.json 凭据片段"), displayValue: credentialsSnippet(displayedToken, "api_key"), copyValue: credentialsSnippet(token, "api_key") },
      { label: t("settings.json 默认模型片段"), displayValue: defaults, copyValue: defaults },
      { label: t("会话扩展片段（flowlet.ts）"), displayValue: PI_SESSION_EXTENSION, copyValue: PI_SESSION_EXTENSION },
    ];
  },
};

const codexAdapter: AgentAccessAdapter = {
  id: "codex",
  installationName: (surface) => surface === "desktop" ? "ChatGPT Desktop" : "Codex CLI",
  configStatuses: ({ globalConfig, t }) => [{ label: t("模型目录"), value: t(globalConfig?.model_catalog_configured ? "已配置" : "未配置") }],
  configControls: () => [],
  applyOptions: () => undefined,
  manualSnippets: ({ endpoint, token, displayedToken, t }) => {
    const config = [
      'model = "flowlet-pro"',
      'model_provider = "flowlet"',
      "disable_response_storage = true",
      'preferred_auth_method = "apikey"',
      'model_catalog_json = "~/.codex/model-catalog.flowlet.json"',
      "",
      "[model_providers.flowlet]",
      'name = "flowlet"',
      `base_url = "${endpoint}"`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n");
    const credentials = (apiKey: string) => JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2);
    return [
      { label: t("config.toml 配置片段"), displayValue: config, copyValue: config },
      { label: t("auth.json 凭据片段"), displayValue: credentials(displayedToken), copyValue: credentials(token) },
      { label: t("模型目录片段（保存为 ~/.codex/model-catalog.flowlet.json）"), displayValue: CODEX_MODEL_CATALOG_JSON, copyValue: CODEX_MODEL_CATALOG_JSON },
    ];
  },
};

const ADAPTERS: Record<AgentGlobalConfigAdapterId, AgentAccessAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: openCodeAdapter,
  pi: piAdapter,
  codex: codexAdapter,
};

export function agentAccessAdapter(adapterId: AgentGlobalConfigAdapterId): AgentAccessAdapter {
  const adapter = ADAPTERS[adapterId];
  if (!adapter) throw new Error(`Agent access adapter is not registered: ${adapterId}`);
  return adapter;
}
