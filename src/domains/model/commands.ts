import { invokeCommand, toAppError } from "../../platform/tauri/client";
import {
  FLOWLET_SUPPORTED_MODELS,
  canonicalModelId,
  isCustomChannel,
  resolveSelectedUpstreamModelIds,
} from "../channel/types";
import { effectiveAnthropicBaseUrl, effectiveOpenAiBaseUrl, type ChannelAccount } from "../account/types";
import type { ChannelPreset, ProtocolType } from "../channel/types";
import type { ChannelModel, ModelExposureMode, RouteCandidate } from "./types";

/** Model-exposure command adapter. Encapsulates every command touching
 *  channel models, virtual/route models, and model_exposure_mode. */

export const modelCommands = {
  listChannelModels: (): Promise<ChannelModel[]> =>
    invokeCommand<ChannelModel[]>("list_channel_models").catch(toAppErr("model_list_failed")),

  listRouteCandidates: (): Promise<RouteCandidate[]> =>
    invokeCommand<RouteCandidate[]>("list_route_candidates").catch(toAppErr("routes_list_failed")),

  saveRouteCandidates: (routes: RouteCandidate[]): Promise<void> =>
    invokeCommand<void>("save_route_candidates", { routes }).catch(toAppErr("routes_save_failed")),

  readExposureMode: (): Promise<ModelExposureMode> =>
    invokeCommand<string>("read_app_meta", { key: "model_exposure_mode" })
      .then((v) => (v === "flowlet_only" || v === "custom" ? v : "all"))
      .catch(toAppErr("exposure_read_failed")),

  setExposureMode: (mode: ModelExposureMode): Promise<void> =>
    invokeCommand<void>("write_app_meta", { key: "model_exposure_mode", value: mode }).catch(
      toAppErr("exposure_write_failed"),
    ),
};

function toAppErr(code: string) {
  return (err: unknown) => {
    throw toAppError(err, code);
  };
}

/** Compute the exposed routes for a channel from each account's user-selected
 *  `exposed_models`. Pure helper shared by the save-time reconciliation and tests. */
export function buildDefaultRoutes(
  channelId: string,
  accounts: ChannelAccount[],
  protocol: ProtocolType,
): RouteCandidate[] {
  const firstAccountId = accounts
    .reduce<ChannelAccount | null>((first, account) => {
      if (!first) return account;
      const createdOrder = (account.created_at?.trim() ?? "")
        .localeCompare(first.created_at?.trim() ?? "");
      return createdOrder < 0 || (createdOrder === 0 && account.id.localeCompare(first.id) < 0)
        ? account
        : first;
    }, null)
    ?.id;
  const usable = accounts.filter((a) => {
    if (a.channel_id !== channelId || !a.enabled || !a.api_key.trim()) return false;
    // Responses 端点从 OpenAI Base URL 派生，自定义渠道门禁与 openai 相同。
    return protocol === "openai" || protocol === "responses"
      ? Boolean(effectiveOpenAiBaseUrl(a)) || channelId !== "custom"
      : Boolean(effectiveAnthropicBaseUrl(a)) || channelId !== "custom";
  });
  const now = new Date().toISOString();
  const out: RouteCandidate[] = [];
  usable.forEach((acc, j) => {
    const exposedModels = defaultModelsForAccount(channelId, acc);
    exposedModels.forEach(({ canonical: up, upstream }, i) => {
      out.push({
        id: `route-${acc.id}-${upstream}-${protocol}-${i}-${j}`,
        virtual_model_id: up,
        channel_id: channelId,
        account_id: acc.id,
        // 对外模型名用白名单规范 ID；转发上游时保留 /models 返回的原名
        // （变体别名如 deepseek-v4-flash-0731 按上游实际支持的名字发起请求）。
        upstream_model: upstream,
        client_protocol: protocol,
        priority: j,
        // 仅全局第一个渠道账号的新路由默认开启；后续账号仍自动补齐路由，
        // 但需要用户在模型服务页手动开启。
        enabled: acc.id === firstAccountId,
        created_at: now,
        updated_at: now,
      });
    });
  });
  return out;
}

/** Models one account exposes: the user-selected `exposed_models` intersected
 *  with the latest `/models` result and the global supported-models set. The
 *  whitelist is NOT per-channel — any account may expose any model Flowlet
 *  supports, as long as that account's `/models` returned it (directly, or as
 *  an aliased upstream resource such as `deepseek-v4-flash-0731` for
 *  `deepseek-v4-flash`). Multiple raw upstream IDs may resolve to the same
 *  canonical model and must remain separate route candidates.
 *  Returns `{ canonical, upstream }` pairs: `canonical` is the whitelist name
 *  used as `virtual_model_id`; `upstream` is the name to send upstream (the raw
 *  selected `/models` entry). Legacy canonical selections still fall back to
 *  the first matching alias when the exact canonical ID is absent.
 *  `exposed_models = null` (not yet configured) or empty → no models exposed.
 *  Mirrors the Rust-side selection in channels_config.merge_default_routes. */
function defaultModelsForAccount(
  _channelId: string,
  account: ChannelAccount,
): Array<{ canonical: string; upstream: string }> {
  const exposed = account.exposed_models ?? null;
  if (!exposed || exposed.length === 0) return [];
  return resolveSelectedUpstreamModelIds(exposed, account.synced_models).flatMap((upstream) => {
    const canonical = canonicalModelId(upstream);
    return canonical ? [{ canonical, upstream }] : [];
  });
}

/** Add only missing direct-model routes for each account's
 *  selected `exposed_models`. Existing routes are returned unchanged so
 *  user-controlled enabled state, priority and timestamps survive. Removing
 *  deselected models is the caller's job (see the save-time reconciliation).
 *  Aggregate membership is managed explicitly on the model-services page and
 *  is never inferred from an upstream model name. New routes are enabled only
 *  for the globally earliest account; routes added
 *  for every later official or custom account start disabled. */
export function mergeDefaultRoutes(
  existing: RouteCandidate[],
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
): RouteCandidate[] {
  const merged = [...existing];
  const signatures = new Set(existing.map(routeSignature));

  for (const preset of presets) {
    for (const protocol of preset.supported_protocols ?? []) {
      for (const route of buildDefaultRoutes(preset.id, accounts, protocol)) {
        const signature = routeSignature(route);
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        merged.push(route);
      }
    }
  }
  return merged;
}

/** Reconcile routes against each account's user-selected `exposed_models` and
 *  latest `/models` result: remove routes whose upstream model was deselected,
 *  was not returned by `/models`, or is globally unsupported (account configured,
 *  i.e. `exposed_models != null`), then add missing valid routes via
 *  mergeDefaultRoutes (preserving enabled state / priority).
 *  Accounts with `exposed_models = null` (not yet configured in the new UI)
 *  are left untouched, so legacy accounts keep their routes. */
export function reconcileAccountRoutes(
  existing: RouteCandidate[],
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
): RouteCandidate[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const pruned = existing.filter((route) => {
    const account = accountById.get(route.account_id);
    if (!account) return true;
    const exposed = account?.exposed_models ?? null;
    if (exposed == null) return true; // 未配置的账号保持现状
    if (!account.enabled || !account.api_key.trim()) return false;
    if (account && isCustomChannel(presetById.get(account.channel_id))) {
      const hasEndpoint =
        route.client_protocol === "openai" || route.client_protocol === "responses"
          ? Boolean(effectiveOpenAiBaseUrl(account))
          : Boolean(effectiveAnthropicBaseUrl(account));
      if (!hasEndpoint) return false;
    }
    const expectedUpstream = new Set(
      defaultModelsForAccount(account.channel_id, account)
        .map(({ upstream }) => upstream.toLowerCase()),
    );
    return expectedUpstream.has(route.upstream_model.trim().toLowerCase());
  });
  return mergeDefaultRoutes(pruned, accounts, presets);
}

/** True when two route lists differ as multisets of route signatures. */
export function routesDiffer(a: RouteCandidate[], b: RouteCandidate[]): boolean {
  if (a.length !== b.length) return true;
  const sigsA = new Set(a.map(routeSignature));
  return b.some((route) => !sigsA.has(routeSignature(route)));
}

export function routeSignature(route: RouteCandidate) {
  return [route.virtual_model_id, route.channel_id, route.account_id, route.upstream_model, route.client_protocol].join("\u0000");
}
