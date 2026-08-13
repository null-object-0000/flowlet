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

    expect(snippets[0].copyValue).toContain('"x-flowlet-client": "pi"');
    expect(snippets[3].copyValue).toContain('event.headers["x-flowlet-session"] = sessionId');
    expect(agentAccessAdapter("pi").applyOptions(context({ session_extension: false })))
      .toEqual({ sessionExtension: false });
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
  });

  it("keeps DeepSeek Harness managed YAML snippets in sync", () => {
    const adapter = agentAccessAdapter("deepseek-harness");
    const snippets = adapter.manualSnippets(context());

    expect(adapter.installationName("web")).toBe("DeepSeek Harness Web");
    expect(snippets[0].copyValue).toContain("api: openai-completions");
    expect(snippets[0].copyValue).toContain("x-flowlet-client: deepseek-harness");
    expect(snippets[0].copyValue).toContain("agent-default-model:");
    expect(snippets[0].copyValue).toContain("model: flowlet-pro");
    expect(snippets[1].copyValue).toContain("FLOWLET_CLIENT_TOKEN: real-token");
  });
});
