import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import { credentialsSnippet, manualModelValue, modelOptions, modelSelectionOptions, selectedModelValue } from "./shared";

/** OpenCode 写入的是 OpenAI-compatible `/v1` provider，可用模型只取 openai 协议。 */
const OPENCODE_PROTOCOLS: AgentModelProtocol[] = ["openai"];

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

export const openCodeAdapter: AgentAccessAdapter = {
  id: "opencode",
  installationName: (surface) => surface === "desktop" ? "OpenCode Desktop" : "OpenCode CLI",
  configStatuses: ({ globalConfig, t }) => [{
    label: t("权限插件"),
    value: t(globalConfig?.opencode_permission_bridge ? "已安装" : "需安装或更新"),
  }],
  // 输入模态声明已随聚合模型移除；OpenCode 不再有高级可选能力。
  configControls: () => [],
  applyOptions: (context) => modelSelectionOptions(selectedModelValue(modelOptions(context, OPENCODE_PROTOCOLS), context.globalConfig?.primary_model)),
  manualSnippets: (context) => {
    const options = modelOptions(context, OPENCODE_PROTOCOLS);
    const model = manualModelValue(options, context.globalConfig?.primary_model);
    // small_model 的 fast 缺省等于主模型（前端不提供 fast 选择器，由 Rust 写入端缺省）。
    const provider = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: `flowlet/${model}`,
      small_model: `flowlet/${model}`,
      provider: {
        flowlet: {
          name: "Flowlet",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: context.endpoint },
          // 与 Rust 写入端一致：受管 Provider 只声明所选（主/快速）模型条目。
          models: { [model]: { name: model } },
        },
      },
    }, null, 2);
    return [
      { label: context.t("opencode.jsonc 配置片段"), displayValue: provider, copyValue: provider },
      { label: context.t("auth.json 凭据片段"), displayValue: credentialsSnippet(context.displayedToken, "api"), copyValue: credentialsSnippet(context.token, "api") },
      { label: context.t("权限事件插件片段（flowlet.ts）"), displayValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET, copyValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET },
    ];
  },
  modelSelectors: (context) => {
    const options = modelOptions(context, OPENCODE_PROTOCOLS);
    return [{
      id: "primary",
      label: context.t("主模型"),
      value: selectedModelValue(options, context.globalConfig?.primary_model),
      options,
      applyOptions: (value) => modelSelectionOptions(value),
    }];
  },
};
