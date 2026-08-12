import registryJson from "../../../plugin-registry.json";

export type PluginKind = "channel" | "model-catalog" | "agent";
export type AgentPluginId = "claude-code" | "opencode" | "pi" | "codex";
export type AgentGlobalConfigAdapterId = "claude-code" | "opencode" | "pi" | "codex";
export type AgentPluginSurface = "cli" | "desktop";

export type AgentPluginDescriptor = {
  id: AgentPluginId;
  name: string;
  environmentAdapterId: string;
  globalConfigAdapterId: AgentGlobalConfigAdapterId;
  endpointSuffix: "/anthropic" | "/v1";
  npmPackage: string;
  surfaces: AgentPluginSurface[];
  iconSrc: string;
  tone?: "claude" | "neutral";
  officialUrl: string;
  updateUrl: string;
  showsCredentialsFile: boolean;
  showsFastModel: boolean;
  showsSubagentModel: boolean;
  environmentDescription: string;
  notInstalledText: string;
  globalConfigDescription: string;
  manualDescription: string;
  restartTip: string;
};

type ChannelPlugin = { id: string; kind: "channel"; channelId: string; adapterId: string };
type ModelCatalogPlugin = { id: string; kind: "model-catalog"; source: string };
type AgentPlugin = { id: string; kind: "agent"; agent: AgentPluginDescriptor };
type PluginDescriptor = ChannelPlugin | ModelCatalogPlugin | AgentPlugin;
type PluginRegistry = { schemaVersion: number; plugins: PluginDescriptor[] };

const registry = registryJson as PluginRegistry;

function validateRegistry(value: PluginRegistry): void {
  if (value.schemaVersion !== 2) throw new Error(`Unsupported plugin registry schema: ${value.schemaVersion}`);
  const pluginIds = new Set<string>();
  const contributionIds = new Set<string>();
  for (const plugin of value.plugins) {
    if (!plugin.id.trim() || pluginIds.has(plugin.id)) throw new Error(`Duplicate or blank plugin id: ${plugin.id}`);
    pluginIds.add(plugin.id);
    const contributionId = plugin.kind === "channel"
      ? `channel:${plugin.channelId}`
      : plugin.kind === "agent"
        ? `agent:${plugin.agent.id}`
        : `model-catalog:${plugin.source}`;
    if (contributionIds.has(contributionId)) throw new Error(`Duplicate plugin contribution: ${contributionId}`);
    contributionIds.add(contributionId);
    if (plugin.kind === "channel" && !plugin.adapterId.trim()) {
      throw new Error(`Channel plugin adapter is blank: ${plugin.channelId}`);
    }
    if (plugin.kind === "agent" && (!plugin.agent.environmentAdapterId.trim() || !plugin.agent.globalConfigAdapterId.trim())) {
      throw new Error(`Agent plugin adapter is blank: ${plugin.agent.id}`);
    }
  }
}

validateRegistry(registry);

export const CHANNEL_PLUGIN_IDS = registry.plugins
  .filter((plugin): plugin is ChannelPlugin => plugin.kind === "channel")
  .map((plugin) => plugin.channelId);

export const AGENT_PLUGINS = registry.plugins
  .filter((plugin): plugin is AgentPlugin => plugin.kind === "agent")
  .map((plugin) => plugin.agent);

export const MODEL_CATALOG_PLUGIN_SOURCE = registry.plugins
  .find((plugin): plugin is ModelCatalogPlugin => plugin.kind === "model-catalog")?.source;

if (MODEL_CATALOG_PLUGIN_SOURCE !== "model-catalog.json") {
  throw new Error("The builtin model catalog plugin must reference model-catalog.json");
}

export function agentPlugin(agentId: AgentPluginId): AgentPluginDescriptor {
  const descriptor = AGENT_PLUGINS.find((agent) => agent.id === agentId);
  if (!descriptor) throw new Error(`Agent plugin is not registered: ${agentId}`);
  return descriptor;
}
