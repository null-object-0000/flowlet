import type { AgentAccessAdapter } from "../agentAccessAdapters";
import { credentialsSnippet } from "./shared";

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
