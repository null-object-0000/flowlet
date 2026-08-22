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
      .toEqual(["claude-code", "opencode", "pi", "codex", "deepseek-harness"]);
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
    expect(snippets[0].copyValue).toContain("agent-default-model:");
    expect(snippets[0].copyValue).toContain("model: flowlet-pro");
    expect(snippets[1].copyValue).toContain("version: 1");
    expect(snippets[1].copyValue).toContain("refs:\n  FLOWLET_CLIENT_TOKEN: real-token");
    expect(adapter.configStatuses(base)).toEqual([]);
    // 会话关联控件默认关闭，开关只改自身、保留规格声明状态。
    expect(adapter.configControls(base)[0].checked).toBe(false);
    expect(adapter.configControls(base)[0].requiresRestart).toBe(true);
    expect(adapter.configControls(base)[0].applyOptions(true))
      .toEqual({ sessionExtension: true, modelSpecs: false, approvalBridge: false });
    // 模型规格控件默认不填写，与会话关联互相独立。
    expect(adapter.configControls(base)[1].checked).toBe(false);
    expect(adapter.configControls(base)[1].requiresRestart).toBeUndefined();
    expect(adapter.configControls(base)[1].applyOptions(true))
      .toEqual({ sessionExtension: false, modelSpecs: true, approvalBridge: false });
    expect(adapter.configControls(base)[2].requiresRestart).toBe(true);
    // 重新写入按钮保留当前报告状态，默认全关。
    expect(adapter.applyOptions(base)).toEqual({
      sessionExtension: false,
      modelSpecs: false,
      approvalBridge: false,
    });
    expect(adapter.applyOptions(context())).toEqual({
      sessionExtension: false,
      modelSpecs: false,
      approvalBridge: false,
    });
  });
});
