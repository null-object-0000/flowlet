import { describe, expect, it } from "vitest";
import codexModelCatalog from "../../../codex-models.json";
import type { AgentGlobalConfigReport } from "../../domains/agent/types";
import { AGENT_PLUGINS } from "../../domains/pluginRegistry";
import { agentAccessAdapter, type AgentAccessContext } from "./agentAccessAdapters";

const t = (source: string) => source;

function context(globalConfig?: Partial<AgentGlobalConfigReport>): AgentAccessContext {
  return {
    endpoint: "http://127.0.0.1:8787/v1",
    token: "real-token",
    displayedToken: "masked-token",
    globalConfig: globalConfig as AgentGlobalConfigReport | undefined,
    t,
  };
}

describe("agent access adapters", () => {
  it("resolves every registered global config adapter", () => {
    expect(AGENT_PLUGINS.map((plugin) => agentAccessAdapter(plugin.globalConfigAdapterId).id))
      .toEqual(["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"]);
  });

  it("lets Hermes pick the default aggregate model", () => {
    const adapter = agentAccessAdapter("hermes");

    // 默认主模型 flowlet-pro，applyOptions 回填当前选择与会话桥开关。
    expect(adapter.applyOptions(context())).toEqual({ primaryModel: "flowlet-pro", sessionExtension: false });
    const selector = adapter.modelSelector?.(context())!;
    expect(selector.value).toBe("flowlet-pro");
    expect(selector.options.map((option) => option.value)).toEqual(["flowlet-pro", "flowlet-flash"]);
    expect(selector.applyOptions("flowlet-flash")).toEqual({ primaryModel: "flowlet-flash", sessionExtension: false });

    // 已配置 flowlet-flash 时，选择器与片段都反映该选择。
    const flash = context({ primary_model: "flowlet-flash" });
    expect(adapter.applyOptions(flash)).toEqual({ primaryModel: "flowlet-flash", sessionExtension: false });
    expect(adapter.modelSelector?.(flash)!.value).toBe("flowlet-flash");
    expect(adapter.manualSnippets(flash)[0].copyValue).toContain('default: "flowlet-flash"');

    // 非法/缺失值回退 flowlet-pro。
    expect(adapter.applyOptions(context({ primary_model: "gpt-4o" }))).toEqual({ primaryModel: "flowlet-pro", sessionExtension: false });

    // 会话桥开关：勾选时 applyOptions 携带 sessionExtension。
    const withBridge = context({ session_extension: true });
    expect(adapter.applyOptions(withBridge)).toEqual({ primaryModel: "flowlet-pro", sessionExtension: true });
    expect(adapter.configControls(withBridge)[0].checked).toBe(true);
    expect(adapter.configControls(withBridge)[0].applyOptions(false)).toEqual({ primaryModel: "flowlet-pro", sessionExtension: false });

    // 手动片段注入 x-flowlet-client 与 ${HERMES_CUSTOM_...} 引用。
    const snippets = adapter.manualSnippets(context());
    expect(snippets[0].copyValue).toContain('x-flowlet-client: "hermes"');
    expect(snippets[0].copyValue).toContain('api_key: "${HERMES_CUSTOM_127_0_0_1_8787_API_KEY}"');
    expect(snippets[1].copyValue).toBe("HERMES_CUSTOM_127_0_0_1_8787_API_KEY=real-token");
    expect(snippets[2].copyValue).toContain("flowlet-session-bridge");
  });

  it("keeps Claude long-context controls and snippets in sync", () => {
    const adapter = agentAccessAdapter("claude-code");
    const adapterContext = context({ primary_long_context: true, fast_long_context: false });

    expect(adapter.applyOptions(adapterContext)).toEqual({ primaryLongContext: true, fastLongContext: false });
    expect(adapter.configControls(adapterContext)[1].applyOptions(true)).toEqual({
      primaryLongContext: true,
      fastLongContext: true,
    });
    expect(adapter.manualSnippets(adapterContext)[0].copyValue).toContain('"ANTHROPIC_MODEL": "flowlet-pro[1m]"');
    expect(adapter.manualSnippets(adapterContext)[0].copyValue).toContain('"ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash"');
  });

  it("keeps Pi attribution and session integration in manual snippets", () => {
    const snippets = agentAccessAdapter("pi").manualSnippets(context());
    const pi = agentAccessAdapter("pi");

    expect(snippets[0].copyValue).toContain('"x-flowlet-client": "pi"');
    expect(snippets[3].copyValue).toContain('event.headers["x-flowlet-session"] = sessionId');
    expect(pi.applyOptions(context({ session_extension: false, model_specs: false })))
      .toEqual({ sessionExtension: false, modelSpecs: false });
    // 未检测到扩展时默认不开启（高级可选能力默认关闭）。
    expect(pi.applyOptions(context())).toEqual({ sessionExtension: false, modelSpecs: false });
    expect(pi.configControls(context())[0].checked).toBe(false);
    expect(pi.configControls(context())[1].checked).toBe(false);

    const declared = context({
      model_specs: true,
      model_input_modalities: { "flowlet-pro": ["text", "image"], "flowlet-flash": ["text"] },
    });
    const declaredModels = JSON.parse(pi.manualSnippets(declared)[0].copyValue);
    expect(declaredModels.providers.flowlet.models[0].input).toEqual(["text", "image"]);
    expect(declaredModels.providers.flowlet.models[1].input).toEqual(["text"]);
    expect(pi.configControls(declared)[1].applyOptions(false)).toEqual({ sessionExtension: false, modelSpecs: false });
  });

  it("uses the root Codex catalog as the manual snippet source", () => {
    const adapter = agentAccessAdapter("codex");
    const snippets = adapter.manualSnippets(context());

    expect(adapter.installationName("desktop")).toBe("ChatGPT Desktop");
    expect(snippets[0].copyValue).toContain('wire_api = "responses"');
    expect(snippets[2].copyValue).toBe(JSON.stringify(codexModelCatalog, null, 2));
  });

  it("retains the OpenCode permission bridge", () => {
    const adapter = agentAccessAdapter("opencode");
    const snippets = adapter.manualSnippets(context({ opencode_permission_bridge: false }));

    expect(adapter.configStatuses(context({ opencode_permission_bridge: false }))[0].value).toBe("需安装或更新");
    expect(snippets[2].copyValue).toContain("FlowletPermissionBridge");
    expect(adapter.configControls(context())[0].requiresRestart).toBe(true);
    expect(adapter.applyOptions(context())).toEqual({ modelSpecs: false });

    const declared = context({
      model_specs: true,
      model_input_modalities: { "flowlet-pro": ["text", "image"], "flowlet-flash": ["text"] },
    });
    expect(adapter.manualSnippets(declared)[0].copyValue).toContain('"modalities"');
    expect(adapter.manualSnippets(declared)[0].copyValue).toContain('"image"');
  });

  it("keeps DeepSeek Harness managed YAML snippets in sync", () => {
    const adapter = agentAccessAdapter("deepseek-harness");
    const snippets = adapter.manualSnippets(context());
    const base = context({ session_extension: false, model_specs: false });

    expect(adapter.installationName("web")).toBe("DeepSeek Harness Web");
    expect(snippets[0].copyValue).toContain("api: openai-completions");
    expect(snippets[0].copyValue).not.toContain("sessionIdHeader");
    expect(snippets[0].copyValue).not.toContain("x-flowlet-client");
    // 聚合模型规格默认关闭：片段与基础写入一致，不携带任何规格声明。
    expect(snippets[0].copyValue).not.toContain("contextWindow");
    expect(snippets[0].copyValue).not.toContain("input:");
    expect(snippets[0].copyValue).toContain("agent-default-model:");
    expect(snippets[0].copyValue).toContain("model: flowlet-pro");
    expect(snippets[1].copyValue).toContain("version: 1");
    expect(snippets[1].copyValue).toContain("refs:\n  FLOWLET_CLIENT_TOKEN: real-token");
    expect(adapter.configStatuses(base)).toEqual([]);
    // 会话关联控件默认关闭，开关只改自身、保留规格声明状态。
    expect(adapter.configControls(base)[0].checked).toBe(false);
    expect(adapter.configControls(base)[0].requiresRestart).toBe(true);
    expect(adapter.configControls(base)[0].applyOptions(true))
      .toEqual({ sessionExtension: true, modelSpecs: false, approvalBridge: false, mcpServers: [] });
    // 模型规格控件默认不填写，与会话关联互相独立。
    expect(adapter.configControls(base)[1].checked).toBe(false);
    expect(adapter.configControls(base)[1].requiresRestart).toBeUndefined();
    expect(adapter.configControls(base)[1].applyOptions(true))
      .toEqual({ sessionExtension: false, modelSpecs: true, approvalBridge: false, mcpServers: [] });
    expect(adapter.configControls(base)[2].requiresRestart).toBe(true);
    // 重新写入按钮保留当前报告状态（含 MCP 服务器列表），默认全关。
    expect(adapter.applyOptions(base)).toEqual({
      sessionExtension: false,
      modelSpecs: false,
      approvalBridge: false,
      mcpServers: [],
    });
    expect(adapter.applyOptions(context())).toEqual({
      sessionExtension: false,
      modelSpecs: false,
      approvalBridge: false,
      mcpServers: [],
    });

    // 「重新写入」会保留报告中的受管 MCP 服务器列表，不会被默认值清空。
    const withMcp = context({
      session_extension: true,
      approval_bridge: true,
      mcp_servers: [
        {
          id: "chrome",
          serverName: "chrome",
          transport: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated"],
        },
      ],
    });
    expect(adapter.applyOptions(withMcp)).toEqual({
      sessionExtension: true,
      modelSpecs: false,
      approvalBridge: true,
      mcpServers: withMcp.globalConfig?.mcp_servers ?? [],
    });

    // 开启聚合模型规格后，片段必须与一键写入的 settings.yaml 一致：
    // 每个模型条目带 1M 上下文窗口，并按当前可用路由声明输入能力。
    const declared = context({
      model_specs: true,
      model_input_modalities: { "flowlet-pro": ["text", "image"], "flowlet-flash": ["text"] },
    });
    const declaredSettings = adapter.manualSnippets(declared)[0].copyValue;
    expect(declaredSettings).toContain("- id: flowlet-pro\n          contextWindow: 1048576");
    expect(declaredSettings).toContain("- id: flowlet-flash\n          contextWindow: 1048576");
    expect(declaredSettings).toMatch(/- id: flowlet-pro[\s\S]*?input:\n            - text\n            - image/);
    expect(declaredSettings).toMatch(/- id: flowlet-flash[\s\S]*?input:\n            - text\n/);
    // 未上报图像能力时回退为纯文本，与写入端 input_for 的归一化一致。
    const fallback = context({ model_specs: true });
    const fallbackModels = adapter.manualSnippets(fallback)[0].copyValue;
    expect(fallbackModels.match(/input:\n            - text/g)?.length).toBe(2);
    expect(fallbackModels).not.toContain("image");
  });
});
