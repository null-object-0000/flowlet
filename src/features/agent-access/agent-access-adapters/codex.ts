import codexModelCatalog from "../../../../codex-models.json";
import type { AgentAccessAdapter } from "../agentAccessAdapters";

const CODEX_MODEL_CATALOG_JSON = JSON.stringify(codexModelCatalog, null, 2);

export const codexAdapter: AgentAccessAdapter = {
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
