import { describe, expect, it } from "vitest";
import type { ModelsCnCatalog } from "../../domains/modelCatalog/types";
import type { AgentGlobalConfigReport } from "../../domains/agent/types";
import { AGENT_PLUGINS } from "../../domains/pluginRegistry";
import { agentAccessAdapter, type AgentAccessContext, type AgentAvailableModel } from "./agentAccessAdapters";

const t = (source: string) => source;

const AVAILABLE_MODELS: AgentAvailableModel[] = [
  { model: "deepseek-v4-pro", protocols: ["openai", "anthropic"] },
  { model: "gpt-6-sol", protocols: ["responses"] },
  { model: "qwen3.8-flash", protocols: ["openai"] },
];

function context(
  globalConfig?: Partial<AgentGlobalConfigReport>,
  availableModels: AgentAvailableModel[] = AVAILABLE_MODELS,
): AgentAccessContext {
  return {
    endpoint: "http://127.0.0.1:8787/v1",
    token: "real-token",
    displayedToken: "masked-token",
    globalConfig: globalConfig as AgentGlobalConfigReport | undefined,
    availableModels,
    modelCatalog: null,
    t,
  };
}

describe("agent access adapters", () => {
  it("resolves every registered global config adapter", () => {
    expect(AGENT_PLUGINS.map((plugin) => agentAccessAdapter(plugin.globalConfigAdapterId).id))
      .toEqual(["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"]);
  });

  it("lets Hermes pick from openai models and keeps the session bridge", () => {
    const adapter = agentAccessAdapter("hermes");
    const selector = adapter.modelSelectors(context())[0];

    // 只暴露 openai 协议模型，默认取第一个；applyOptions 回填选择与会话桥开关。
    expect(selector.options.map((option) => option.value)).toEqual(["deepseek-v4-pro", "qwen3.8-flash"]);
    expect(selector.value).toBe("deepseek-v4-pro");
    expect(selector.applyOptions("qwen3.8-flash")).toEqual({ primaryModel: "qwen3.8-flash", sessionExtension: false });
    expect(adapter.applyOptions(context())).toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: false });

    // 已配置模型在选项内时，选择器与片段都反映该选择。
    const configured = context({ primary_model: "qwen3.8-flash" });
    expect(adapter.modelSelectors(configured)[0].value).toBe("qwen3.8-flash");
    expect(adapter.applyOptions(configured)).toEqual({ primaryModel: "qwen3.8-flash", sessionExtension: false });
    expect(adapter.manualSnippets(configured)[0].copyValue).toContain('default: "qwen3.8-flash"');

    // 已配置模型不在选项内（如只有 responses 路由）时回退第一个选项。
    expect(adapter.modelSelectors(context({ primary_model: "gpt-6-sol" }))[0].value).toBe("deepseek-v4-pro");

    // 会话桥开关：勾选时保留当前主模型。
    const withBridge = context({ session_extension: true });
    expect(adapter.applyOptions(withBridge)).toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: true });
    expect(adapter.configControls(withBridge)[0].checked).toBe(true);
    expect(adapter.configControls(withBridge)[0].applyOptions(false)).toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: false });

    // 手动片段注入 x-flowlet-client 与 ${HERMES_CUSTOM_...} 引用。
    const snippets = adapter.manualSnippets(context());
    expect(snippets[0].copyValue).toContain('x-flowlet-client: "hermes"');
    expect(snippets[0].copyValue).toContain('api_key: "${HERMES_CUSTOM_127_0_0_1_8787_API_KEY}"');
    expect(snippets[1].copyValue).toBe("HERMES_CUSTOM_127_0_0_1_8787_API_KEY=real-token");
    expect(snippets[2].copyValue).toContain("flowlet-session-bridge");
  });

  it("gives Claude Code primary and fast selectors backed by anthropic models", () => {
    const adapter = agentAccessAdapter("claude-code");
    const adapterContext = context({ primary_model: "deepseek-v4-pro", fast_model: "deepseek-v4-pro" });
    const selectors = adapter.modelSelectors(adapterContext);

    // 只有 anthropic 协议的可用模型可选；Claude Code 提供主模型与快速模型两个选择器。
    expect(selectors.map((selector) => selector.id)).toEqual(["primary", "fast"]);
    expect(selectors[0].options.map((option) => option.value)).toEqual(["deepseek-v4-pro"]);
    expect(selectors[1].value).toBe("deepseek-v4-pro");
    expect(adapter.applyOptions(adapterContext)).toEqual({
      primaryModel: "deepseek-v4-pro",
      fastModel: "deepseek-v4-pro",
    });
    expect(selectors[0].applyOptions("deepseek-v4-pro")).toEqual({
      primaryModel: "deepseek-v4-pro",
      fastModel: "deepseek-v4-pro",
    });

    // 1M 长上下文相关开关与后缀已移除。
    expect(adapter.configControls(adapterContext)).toEqual([]);
    const snippet = adapter.manualSnippets(adapterContext)[0].copyValue;
    expect(snippet).toContain('"ANTHROPIC_MODEL": "deepseek-v4-pro"');
    expect(snippet).toContain('"ANTHROPIC_SMALL_FAST_MODEL": "deepseek-v4-pro"');
    expect(snippet).not.toContain("[1m]");
  });

  it("keeps Pi attribution and session integration in manual snippets", () => {
    const pi = agentAccessAdapter("pi");
    const snippets = pi.manualSnippets(context());

    expect(snippets[0].copyValue).toContain('"x-flowlet-client": "pi"');
    expect(snippets[0].copyValue).not.toContain('"input"');
    expect(snippets[3].copyValue).toContain('event.headers["x-flowlet-session"] = sessionId');
    expect(pi.applyOptions(context({ session_extension: false })))
      .toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: false });
    // 未检测到扩展时默认不开启（高级可选能力默认关闭）。
    expect(pi.applyOptions(context())).toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: false });
    expect(pi.configControls(context())[0].checked).toBe(false);
    expect(pi.configControls(context())[0].applyOptions(true))
      .toEqual({ primaryModel: "deepseek-v4-pro", sessionExtension: true });
    // 输入模态声明开关已随聚合模型移除。
    expect(pi.configControls(context())).toHaveLength(1);
  });

  it("generates the Codex model catalog from the selected responses model", () => {
    const adapter = agentAccessAdapter("codex");
    const adapterContext = context({ primary_model: "gpt-6-sol" });
    const snippets = adapter.manualSnippets(adapterContext);

    expect(adapter.installationName("desktop")).toBe("ChatGPT Desktop");
    expect(adapter.modelSelectors(adapterContext)[0].options.map((option) => option.value)).toEqual(["gpt-6-sol"]);
    expect(snippets[0].copyValue).toContain('model = "gpt-6-sol"');
    expect(snippets[0].copyValue).toContain('wire_api = "responses"');
    // 查不到 models-cn 条目时使用保守条目。
    const fallback = JSON.parse(snippets[2].copyValue);
    expect(fallback.models).toHaveLength(1);
    expect(fallback.models[0]).toMatchObject({
      slug: "gpt-6-sol",
      context_window: 128000,
      max_context_window: 128000,
      input_modalities: ["text"],
    });

    // models-cn 有数据时按目录生成上下文窗口、输入模态与推理档位。
    const catalog: ModelsCnCatalog = {
      schemaVersion: "1",
      providers: [{
        schemaVersion: "1",
        health: { status: "ok", lastSuccessfulAt: "", lastAttemptAt: "", consecutiveFailures: 0 },
        id: "openai",
        name: "OpenAI",
        ownedBy: "openai",
        models: [{
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          aliases: [],
          capabilities: { thinking: true, inputModalities: ["text", "image"] },
          limits: { contextTokens: 400000 },
          prices: [],
        }],
        sources: [],
      }],
      inventories: [],
      calibration: { modelsDev: { models: [] } },
    };
    const dynamicContext: AgentAccessContext = { ...adapterContext, modelCatalog: catalog };
    const dynamic = JSON.parse(adapter.manualSnippets(dynamicContext)[2].copyValue).models[0];
    expect(dynamic).toMatchObject({
      slug: "gpt-6-sol",
      display_name: "GPT-6 Sol",
      context_window: 400000,
      max_context_window: 400000,
      input_modalities: ["text", "image"],
      default_reasoning_level: "high",
    });
    expect(dynamic.supported_reasoning_levels.map((level: { effort: string }) => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(adapter.applyOptions(dynamicContext)).toEqual({ primaryModel: "gpt-6-sol" });
  });

  it("retains the OpenCode permission bridge and writes direct model ids", () => {
    const adapter = agentAccessAdapter("opencode");
    const adapterContext = context({ primary_model: "deepseek-v4-pro", opencode_permission_bridge: false });
    const snippets = adapter.manualSnippets(adapterContext);

    expect(adapter.configStatuses(adapterContext)[0].value).toBe("需安装或更新");
    expect(snippets[2].copyValue).toContain("FlowletPermissionBridge");
    // 输入模态声明已移除，OpenCode 不再有高级可选能力。
    expect(adapter.configControls(adapterContext)).toEqual([]);
    expect(adapter.applyOptions(adapterContext)).toEqual({ primaryModel: "deepseek-v4-pro" });
    const config = JSON.parse(snippets[0].copyValue);
    expect(config.model).toBe("flowlet/deepseek-v4-pro");
    expect(config.small_model).toBe("flowlet/deepseek-v4-pro");
    expect(config.provider.flowlet.models).not.toHaveProperty("modalities");
    // 与 Rust 写入端一致：受管 Provider 只声明所选模型条目。
    expect(Object.keys(config.provider.flowlet.models)).toEqual(["deepseek-v4-pro"]);
  });

  it("keeps DeepSeek Harness managed YAML snippets in sync without model specs", () => {
    const adapter = agentAccessAdapter("deepseek-harness");
    const adapterContext = context({
      session_extension: true,
      mcp_servers: [
        {
          id: "chrome",
          serverName: "chrome",
          transport: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"],
        },
      ],
    });
    const snippets = adapter.manualSnippets(adapterContext);

    expect(adapter.installationName("web")).toBe("DeepSeek Harness Web");
    expect(snippets[0].copyValue).toContain("api: openai-completions");
    expect(snippets[0].copyValue).not.toContain("sessionIdHeader");
    expect(snippets[0].copyValue).not.toContain("x-flowlet-client");
    // 不再声明 contextWindow / 输入模态。
    expect(snippets[0].copyValue).not.toContain("contextWindow");
    expect(snippets[0].copyValue).not.toContain("input:");
    expect(snippets[0].copyValue).toContain("agent-default-model:");
    expect(snippets[0].copyValue).toContain("model: deepseek-v4-pro");
    expect(snippets[0].copyValue).toContain("- id: deepseek-v4-pro");
    expect(snippets[1].copyValue).toContain("version: 1");
    expect(snippets[1].copyValue).toContain("refs:\n  FLOWLET_CLIENT_TOKEN: real-token");
    expect(adapter.configStatuses(adapterContext)).toEqual([]);

    // 高级配置只剩会话关联一项；开关保留主模型与受管 MCP 列表。
    expect(adapter.configControls(adapterContext)).toHaveLength(1);
    expect(adapter.configControls(adapterContext)[0].checked).toBe(true);
    expect(adapter.configControls(adapterContext)[0].requiresRestart).toBe(true);
    expect(adapter.configControls(adapterContext)[0].applyOptions(false)).toEqual({
      primaryModel: "deepseek-v4-pro",
      sessionExtension: false,
      mcpServers: adapterContext.globalConfig?.mcp_servers ?? [],
    });
    expect(adapter.applyOptions(adapterContext)).toEqual({
      primaryModel: "deepseek-v4-pro",
      sessionExtension: true,
      mcpServers: adapterContext.globalConfig?.mcp_servers ?? [],
    });
  });
});
