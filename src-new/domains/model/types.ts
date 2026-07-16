/** Model-domain types (channel models + virtual/exposed models + routes). */

import type { ProtocolType } from "../channel/types";
import type { ChannelAccount } from "../account/types";

export type ModelExposureMode = "all" | "flowlet_only" | "custom";

export type ChannelModel = {
  id: string;
  channel_id: string;
  model: string;
  display_name: string | null;
  supported_protocols: ProtocolType[];
  context_window: number | null;
  max_output_tokens: number | null;
  supports_stream: boolean;
  enabled: boolean;
  source: string;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
};

/** RouteCandidate: an exposed model bound to a channel+account+upstream model.
 *  This is what used to be "开放模型" in the old frontend. */
export type RouteCandidate = {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: ProtocolType;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ConfigurationStatus = "unconfigured" | "no_models" | "ready";

/** Derive model-service configuration status purely from accounts + exposed
 *  routes — deliberately independent of the proxy running/stopped state
 *  (AGENTS.md §4). */
export function deriveConfigurationStatus(
  accounts: ChannelAccount[],
  routes: RouteCandidate[],
): ConfigurationStatus {
  const usableAccounts = accounts.filter((a) => a.enabled && a.api_key.trim().length > 0);
  if (usableAccounts.length === 0) return "unconfigured";
  const usableAccountIds = new Set(usableAccounts.map((account) => account.id));
  const enabledRoutes = routes.filter((route) => route.enabled && usableAccountIds.has(route.account_id));
  if (enabledRoutes.length === 0) return "no_models";
  return "ready";
}
