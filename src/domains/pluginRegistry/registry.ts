import registryJson from "../../../plugin-registry.json";

export type PluginKind = "channel" | "model-catalog" | "agent";
export type AgentPluginId = "claude-code" | "opencode" | "pi" | "codex" | "deepseek-harness";
export type AgentGlobalConfigAdapterId = "claude-code" | "opencode" | "pi" | "codex" | "deepseek-harness";
export type AgentSessionAdapterId = "claude-code" | "opencode" | "pi" | "codex" | "deepseek-harness";
export type AgentIdentityAdapterId = "claude-code" | "opencode" | "pi" | "codex" | "deepseek-harness";
export type AgentRunnerAdapterId = "claude-code" | "opencode" | "pi" | "codex" | "deepseek-harness";
export type AgentPluginSurface = "cli" | "desktop" | "web";

export type AgentSessionTypeDescriptor = { id: string; name: string; clientId: string };
export type AgentTaskProfileDescriptor = { name: string; sessionType: string };
export type AgentConfigCapabilityDescriptor = {
  id: string;
  name: string;
  /** boolean = 布尔开关；list = 受管列表（当前仅 DeepSeek Harness 的 MCP 服务器）。 */
  kind: "boolean" | "list";
  defaultEnabled: boolean;
  requiresRestart: boolean;
};

export type AgentPluginDescriptor = {
  id: AgentPluginId;
  name: string;
  environmentAdapterId: string;
  globalConfigAdapterId: AgentGlobalConfigAdapterId;
  sessionAdapterId: AgentSessionAdapterId;
  identityAdapterId: AgentIdentityAdapterId;
  runnerAdapterId: AgentRunnerAdapterId;
  sessionTypes: AgentSessionTypeDescriptor[];
  taskProfile: AgentTaskProfileDescriptor;
  configCapabilities: AgentConfigCapabilityDescriptor[];
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
  supportsManagedConfig: boolean;
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
  if (value.schemaVersion !== 4) throw new Error(`Unsupported plugin registry schema: ${value.schemaVersion}`);
  const pluginIds = new Set<string>();
  const contributionIds = new Set<string>();
  const sessionTypeIds = new Set<string>();
  const taskProfileNames = new Set<string>();
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
    if (plugin.kind === "agent" && (!plugin.agent.environmentAdapterId.trim() || !plugin.agent.globalConfigAdapterId.trim() || !plugin.agent.sessionAdapterId.trim() || !plugin.agent.identityAdapterId.trim() || !plugin.agent.runnerAdapterId.trim())) {
      throw new Error(`Agent plugin adapter is blank: ${plugin.agent.id}`);
    }
    if (plugin.kind === "agent" && (!plugin.agent.sessionTypes.length || !plugin.agent.taskProfile.name.trim() || !plugin.agent.taskProfile.sessionType.trim())) {
      throw new Error(`Agent plugin capabilities are incomplete: ${plugin.agent.id}`);
    }
    if (plugin.kind === "agent" && !plugin.agent.sessionTypes.some((session) => session.id === plugin.agent.taskProfile.sessionType)) {
      throw new Error(`Agent task session type is not registered: ${plugin.agent.id}/${plugin.agent.taskProfile.sessionType}`);
    }
    if (plugin.kind === "agent") {
      const capabilityIds = new Set<string>();
      for (const session of plugin.agent.sessionTypes) {
        if (!session.id.trim() || !session.name.trim() || !session.clientId.trim() || sessionTypeIds.has(session.id)) {
          throw new Error(`Duplicate or blank Agent session type: ${session.id}`);
        }
        sessionTypeIds.add(session.id);
      }
      for (const capability of plugin.agent.configCapabilities) {
        if (!capability.id.trim() || !capability.name.trim() || (capability.kind !== "boolean" && capability.kind !== "list") || capabilityIds.has(capability.id)) {
          throw new Error(`Duplicate or invalid Agent config capability: ${plugin.agent.id}/${capability.id}`);
        }
        capabilityIds.add(capability.id);
      }
      if (taskProfileNames.has(plugin.agent.taskProfile.name)) {
        throw new Error(`Duplicate Agent task profile: ${plugin.agent.taskProfile.name}`);
      }
      taskProfileNames.add(plugin.agent.taskProfile.name);
    }
    if (plugin.kind === "agent" && typeof plugin.agent.supportsManagedConfig !== "boolean") {
      throw new Error(`Agent plugin managed-config capability is missing: ${plugin.agent.id}`);
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

export const AGENT_SESSION_OPTIONS = AGENT_PLUGINS.flatMap((agent) => agent.sessionTypes);

export const AGENT_TASK_PROFILE_OPTIONS = AGENT_PLUGINS.map((agent) => ({
  value: agent.taskProfile.name,
  label: agent.taskProfile.name,
  sessionType: agent.taskProfile.sessionType,
}));

export function registeredAgentSessionLabel(agentType: string): string | undefined {
  return AGENT_SESSION_OPTIONS.find((session) => session.id === agentType)?.name;
}

export function agentTaskSessionType(profile: string): string | undefined {
  return AGENT_TASK_PROFILE_OPTIONS.find((option) => option.value === profile)?.sessionType;
}

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
