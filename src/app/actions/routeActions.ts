import { RouteCandidate, RouteRule, createRouteCandidate, genId } from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { buildDefaultExposedRoutes } from "../routeHelpers";
import { ActionContext } from "./types";

export function createRouteActions({ data, setMessage }: ActionContext) {
  const { channels, accounts, routes, setRoutes, routeRules, setRouteRules } = data;

  async function saveRouteCandidates() {
    await runCommand("save_route_candidates", { routes });
    // 热更新：代理运行中自动读取最新配置，无需重启
    setMessage("路由配置已保存");
  }

  async function saveRouteRules() {
    const filtered = routeRules.filter((r) => r.name.trim() && r.target_channel_id.trim());
    await runCommand("save_route_rules", { rules: filtered });
    setRouteRules(filtered);
    setMessage("路由规则已保存");
  }

  async function regenerateDefaultRoutes() {
    const enabledAccounts = accounts.filter((account) => account.enabled && account.api_key.trim());
    if (enabledAccounts.length === 0) {
      setMessage("请先新增并启用至少一个已填写 API Key 的账号");
      return;
    }
    const nextRoutes = buildDefaultExposedRoutes(channels, enabledAccounts);
    await runCommand("save_route_candidates", { routes: nextRoutes });
    setRoutes(nextRoutes);
    // 热更新：代理运行中自动读取最新配置，无需重启
    setMessage("默认开放模型已重新生成");
  }

  function createRouteRule(): RouteRule {
    const now = new Date().toISOString();
    return {
      id: genId("rule"),
      name: "新规则",
      enabled: true,
      priority: 0,
      match_client_id: null,
      match_model: null,
      match_protocol: null,
      target_channel_id: channels[0]?.id ?? "longcat",
      target_account_id: accounts.find((a) => a.channel_id === (channels[0]?.id ?? "longcat"))?.id ?? "",
      target_upstream_model: channels[0]?.default_model ?? "",
      created_at: now,
      updated_at: now,
    };
  }

  function addRouteRule() {
    setRouteRules((current) => [...current, createRouteRule()]);
  }

  function updateRouteRule(index: number, patch: Partial<RouteRule>) {
    setRouteRules((current) =>
      current.map((r, i) => (i === index ? { ...r, ...patch, updated_at: new Date().toISOString() } : r))
    );
  }

  function removeRouteRule(index: number) {
    setRouteRules((current) => current.filter((_, i) => i !== index));
  }

  function addRoute() {
    const channelId = channels[0]?.id ?? "longcat";
    const accountId = accounts.find((a) => a.channel_id === channelId)?.id ?? "";
    const upstreamModel = channels[0]?.default_model ?? "";
    setRoutes((current) => [
      ...current,
      createRouteCandidate("auto", channelId, accountId, upstreamModel, "openai", current.length),
    ]);
  }

  function updateRoute(index: number, patch: Partial<RouteCandidate>) {
    setRoutes((current) =>
      current.map((r, i) => {
        if (i !== index) return r;
        const next = { ...r, ...patch, updated_at: new Date().toISOString() };
        if (patch.channel_id && patch.channel_id !== r.channel_id) {
          const channel = channels.find((c) => c.id === patch.channel_id);
          const account = accounts.find((a) => a.channel_id === patch.channel_id);
          next.account_id = account?.id ?? "";
          next.upstream_model = channel?.default_model ?? "";
        }
        if (patch.account_id) {
          const account = accounts.find((a) => a.id === patch.account_id);
          const channel = channels.find((c) => c.id === account?.channel_id);
          next.channel_id = account?.channel_id ?? next.channel_id;
          next.upstream_model = channel?.default_model ?? next.upstream_model;
        }
        return next;
      })
    );
  }

  function removeRoute(index: number) {
    setRoutes((current) => current.filter((_, i) => i !== index));
  }

  return {
    saveRouteCandidates,
    saveRouteRules,
    regenerateDefaultRoutes,
    addRouteRule,
    updateRouteRule,
    removeRouteRule,
    addRoute,
    updateRoute,
    removeRoute,
  };
}
