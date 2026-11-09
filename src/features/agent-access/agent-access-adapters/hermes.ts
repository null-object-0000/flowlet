import type { AgentAccessAdapter, AgentModelProtocol } from "../agentAccessAdapters";
import { manualModelValue, modelOptions, modelSelectionOptions, selectedModelValue } from "./shared";

/** Hermes 使用 OpenAI-compatible 端点；可用模型只取 openai 协议。 */
const HERMES_PROTOCOLS: AgentModelProtocol[] = ["openai"];

// 复刻 Hermes `custom_endpoint_key_env(identity)`：从 Base URL 提取 host:port，归一为
// `[A-Z0-9]+`（其余字符折叠为单个 `_`、去首尾 `_`），生成 `HERMES_CUSTOM_<slug>_API_KEY`。
// 与 Rust 端 hermes.rs 保持一致，确保手动片段和一键写入引用同一个 .env 变量。
function hermesCustomKeyEnv(baseUrl: string): string {
  const withoutScheme = baseUrl.trim().replace(/^https?:\/\//, "");
  const identity = withoutScheme.split("/")[0].trim();
  let slug = "";
  let previousSeparator = false;
  for (const character of identity) {
    if (/[A-Za-z0-9]/.test(character)) {
      slug += character.toUpperCase();
      previousSeparator = false;
    } else if (!previousSeparator) {
      slug += "_";
      previousSeparator = true;
    }
  }
  slug = slug.replace(/^_+|_+$/g, "");
  return slug ? `HERMES_CUSTOM_${slug}_API_KEY` : "HERMES_CUSTOM_API_KEY";
}

// Hermes Agent（Nous Research）的全局配置在 `~/.hermes/config.yaml` 的 `model:` 段：
// `provider: "custom"` + `base_url` 描述 OpenAI 兼容端点，`default` 是主模型，
// `api_key` 是 `${HERMES_CUSTOM_<host:port>_API_KEY}` 引用（真实密钥在 `~/.hermes/.env`），
// `default_headers` 注入 `x-flowlet-client: hermes` 用于客户端归属。与一键写入一致。
export const hermesAdapter: AgentAccessAdapter = {
  id: "hermes",
  installationName: () => "Hermes Agent CLI",
  configStatuses: () => [],
  configControls: (context) => {
    const primaryModel = selectedModelValue(modelOptions(context, HERMES_PROTOCOLS), context.globalConfig?.primary_model);
    return [{
      id: "session-extension",
      label: context.t("精确会话关联"),
      descriptions: [
        context.t("Hermes 复用 OpenAI Python SDK，原生请求不携带会话标识；开启后 Flowlet 部署受管插件，为发往本地代理的请求注入会话头，使请求能按会话归并。"),
        context.t("插件写入 ~/.hermes/plugins/flowlet-session-bridge/ 并在 plugins.enabled 注册；启用或关闭后需重启 Hermes（gateway 需 hermes gateway restart）。"),
      ],
      checked: context.globalConfig?.session_extension ?? false,
      requiresRestart: true,
      applyOptions: (checked) => ({
        ...modelSelectionOptions(primaryModel),
        sessionExtension: checked,
      }),
    }];
  },
  applyOptions: (context) => ({
    ...modelSelectionOptions(selectedModelValue(modelOptions(context, HERMES_PROTOCOLS), context.globalConfig?.primary_model)),
    sessionExtension: context.globalConfig?.session_extension ?? false,
  }),
  modelSelectors: (context) => {
    const options = modelOptions(context, HERMES_PROTOCOLS);
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
  manualSnippets: (context) => {
    const options = modelOptions(context, HERMES_PROTOCOLS);
    const model = manualModelValue(options, context.globalConfig?.primary_model);
    const envKey = hermesCustomKeyEnv(context.endpoint);
    const config = [
      "model:",
      '  provider: "custom"',
      `  default: "${model}"`,
      `  base_url: "${context.endpoint}"`,
      `  api_key: "\${${envKey}}"`,
      "  default_headers:",
      '    x-flowlet-client: "hermes"',
    ].join("\n");
    const env = (apiKey: string) => `${envKey}=${apiKey}`;
    const bridgeNote = [
      "# 精确会话关联（可选）：由 Flowlet 受管写入 ~/.hermes/plugins/flowlet-session-bridge/",
      "# （plugin.yaml + __init__.py），并在 config.yaml 的 plugins.enabled 注册该插件。",
      "# 插件注册 llm_request 中间件，为发往 Flowlet 的请求注入 x-flowlet-session。",
      "# 启用或关闭后需重启 Hermes（gateway 需 hermes gateway restart）。",
    ].join("\n");
    return [
      {
        label: context.t("config.yaml 配置片段"),
        displayValue: config,
        copyValue: config,
      },
      {
        label: context.t("~/.hermes/.env 凭据片段"),
        displayValue: env(context.displayedToken),
        copyValue: env(context.token),
      },
      {
        label: context.t("精确会话关联说明"),
        displayValue: bridgeNote,
        copyValue: bridgeNote,
      },
    ];
  },
};
