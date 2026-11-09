import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import { credentialsSnippet, manualModelValue, modelOptions, modelSelectionOptions, selectedModelValue } from "./shared";

/** Pi 写入的是 OpenAI-compatible `/v1` provider，可用模型只取 openai 协议。 */
const PI_PROTOCOLS: AgentModelProtocol[] = ["openai"];

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
  configControls: (context) => {
    const sessionExtension = context.globalConfig?.session_extension ?? false;
    const primaryModel = selectedModelValue(modelOptions(context, PI_PROTOCOLS), context.globalConfig?.primary_model);
    return [{
      id: "session-extension",
      label: context.t("会话扩展"),
      descriptions: [context.t("安装后可为请求注入会话标识，Flowlet 按会话归并请求；未安装则无法做会话维度串联。"), context.t("Pi 仍可作为 Flowlet 客户端使用，仅会话维度数据不可用。")],
      checked: sessionExtension,
      applyOptions: (checked) => ({ ...modelSelectionOptions(primaryModel), sessionExtension: checked }),
    }];
  },
  applyOptions: (context) => ({
    ...modelSelectionOptions(selectedModelValue(modelOptions(context, PI_PROTOCOLS), context.globalConfig?.primary_model)),
    sessionExtension: context.globalConfig?.session_extension ?? false,
  }),
  manualSnippets: (context) => {
    const options = modelOptions(context, PI_PROTOCOLS);
    const primaryModel = manualModelValue(options, context.globalConfig?.primary_model);
    const models = JSON.stringify({
      providers: {
        flowlet: {
          baseUrl: context.endpoint,
          api: "openai-completions",
          headers: { "x-flowlet-client": "pi" },
          // 与 Rust 写入端一致：受管 Provider 只声明所选（主/快速）模型条目。
          models: [{ id: primaryModel, name: primaryModel }],
        },
      },
    }, null, 2);
    const defaults = JSON.stringify({ defaultProvider: "flowlet", defaultModel: primaryModel }, null, 2);
    return [
      { label: context.t("models.json Provider 片段"), displayValue: models, copyValue: models },
      { label: context.t("auth.json 凭据片段"), displayValue: credentialsSnippet(context.displayedToken, "api_key"), copyValue: credentialsSnippet(context.token, "api_key") },
      { label: context.t("settings.json 默认模型片段"), displayValue: defaults, copyValue: defaults },
      { label: context.t("会话扩展片段（flowlet.ts）"), displayValue: PI_SESSION_EXTENSION, copyValue: PI_SESSION_EXTENSION },
    ];
  },
  modelSelectors: (context) => {
    const options = modelOptions(context, PI_PROTOCOLS);
    return [{
      id: "primary",
      label: context.t("主模型"),
      value: selectedModelValue(options, context.globalConfig?.primary_model),
      options,
      applyOptions: (value) => ({
        ...modelSelectionOptions(value),
        sessionExtension: context.globalConfig?.session_extension ?? false,
      }),
    }];
  },
};