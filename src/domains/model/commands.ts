import { invokeCommand, toAppError } from "../../platform/tauri/client";
import { DEFAULT_EXPOSED_MODELS_BY_CHANNEL, FLOWLET_TIERS_BY_CHANNEL_MODEL } from "../channel/types";
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

/** Compute the default exposed routes for a channel given its usable accounts,
 *  mirroring the old routeHelpers.ensureDefaultExposedRoutes for the
 *  "全部开放" mode on first account creation. This is a pure helper so the UI
 *  and tests can reuse it without re-deriving. */
export function buildDefaultRoutes(
  channelId: string,
  accounts: ChannelAccount[],
  protocol: ProtocolType,
): RouteCandidate[] {
  const upstreamModels = DEFAULT_EXPOSED_MODELS_BY_CHANNEL[channelId] ?? [];
  const usable = accounts.filter((a) => a.channel_id === channelId && a.enabled && a.api_key.trim());
  const now = new Date().toISOString();
  const out: RouteCandidate[] = [];
  upstreamModels.forEach((up, i) => {
    const tiers = FLOWLET_TIERS_BY_CHANNEL_MODEL[channelId]?.[up.toLowerCase()] ?? [];
    const publicModels = [up, ...tiers.map((tier) => `flowlet-${tier}`)];
    usable.forEach((acc, j) => {
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
          enabled: true,
          created_at: now,
          updated_at: now,
        });
      });
    });
  });
  return out;
}

/** Add only missing default direct-model and Flowlet aggregate routes. Existing routes are returned
 * unchanged so user-controlled enabled state, priority and timestamps survive
 * account edits and repeated model synchronization. */
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

function routeSignature(route: RouteCandidate) {
  return [route.virtual_model_id, route.channel_id, route.account_id, route.upstream_model, route.client_protocol].join("\u0000");
}
