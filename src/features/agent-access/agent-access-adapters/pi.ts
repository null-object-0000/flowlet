import type { AgentAccessAdapter } from "../agentAccessAdapters";
import { credentialsSnippet } from "./shared";

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

export const piAdapter: AgentAccessAdapter = {
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
