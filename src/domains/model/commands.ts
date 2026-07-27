import { invokeCommand, toAppError } from "../../platform/tauri/client";
import { FLOWLET_SUPPORTED_MODELS, FLOWLET_TIERS_BY_MODEL, isCustomChannel } from "../channel/types";
import type { ChannelAccount } from "../account/types";
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
    return protocol === "openai"
      ? Boolean(a.base_url_override?.trim()) || channelId !== "custom"
      : Boolean(a.anthropic_base_url_override?.trim()) || channelId !== "custom";
  });
  const now = new Date().toISOString();
  const out: RouteCandidate[] = [];
  usable.forEach((acc, j) => {
    const upstreamModels = defaultModelsForAccount(channelId, acc);
    upstreamModels.forEach((up, i) => {
      // 档位映射按模型全局查找（不按渠道），与全局白名单语义一致。
      const tiers = FLOWLET_TIERS_BY_MODEL[up.toLowerCase()] ?? [];
      const publicModels = [up, ...tiers.map((tier) => `flowlet-${tier}`)];
      publicModels.forEach((publicModel) => {
        out.push({
          id: publicModel === up
            ? `route-${acc.id}-${up}-${protocol}-${i}-${j}`
            : `route-${acc.id}-${publicModel}-${up}-${protocol}-${i}-${j}`,
          virtual_model_id: publicModel,
          channel_id: channelId,
          account_id: acc.id,
          upstream_model: up,
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
  });
  return out;
}

/** Upstream models one account exposes: the user-selected `exposed_models`
 *  intersected with the latest `/models` result and the global supported-models
 *  set. The whitelist is NOT per-channel — any account may expose any model
 *  Flowlet supports, as long as that account's `/models` returned it.
 *  `exposed_models = null` (not yet configured) or empty → no models exposed.
 *  Mirrors the Rust-side selection in channels_config.merge_default_routes. */
function defaultModelsForAccount(_channelId: string, account: ChannelAccount): string[] {
  const exposed = account.exposed_models ?? null;
  if (!exposed || exposed.length === 0) return [];
  const exposedSet = new Set(exposed.map((m) => m.trim().toLowerCase()).filter(Boolean));
  const syncedSet = new Set(
    (account.synced_models ?? []).map((m) => m.trim().toLowerCase()).filter(Boolean),
  );
  return FLOWLET_SUPPORTED_MODELS.filter((m) => {
    const key = m.trim().toLowerCase();
    return exposedSet.has(key) && syncedSet.has(key);
  });
}

/** Add only missing direct-model and Flowlet aggregate routes for each account's
 *  selected `exposed_models`. Existing routes are returned unchanged so
 *  user-controlled enabled state, priority and timestamps survive. Removing
 *  deselected models is the caller's job (see the save-time reconciliation).
 *  New routes are enabled only for the globally earliest account; routes added
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
  const supportedModels = new Set(FLOWLET_SUPPORTED_MODELS.map((model) => model.toLowerCase()));
  const pruned = existing.filter((route) => {
    const account = accountById.get(route.account_id);
    const exposed = account?.exposed_models ?? null;
    if (exposed == null) return true; // 未配置的账号保持现状
    const upstreamKey = route.upstream_model.trim().toLowerCase();
    if (!supportedModels.has(upstreamKey)) return false;
    const syncedSet = new Set(
      (account?.synced_models ?? []).map((m) => m.trim().toLowerCase()).filter(Boolean),
    );
    if (!syncedSet.has(upstreamKey)) return false;
    if (account && isCustomChannel(presetById.get(account.channel_id))) {
      const hasEndpoint = route.client_protocol === "openai"
        ? Boolean(account.base_url_override?.trim())
        : Boolean(account.anthropic_base_url_override?.trim());
      if (!hasEndpoint) return false;
    }
    const exposedSet = new Set(exposed.map((m) => m.trim().toLowerCase()));
    return exposedSet.has(upstreamKey);
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
