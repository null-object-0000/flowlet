import { describe, expect, it } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { buildModelServiceItems } from "./modelServiceView";

describe("buildModelServiceItems", () => {
  it("groups routes by external model and derives availability from accounts", () => {
    const accounts = [{ id: "a1", enabled: true, api_key: "sk", credential_status: "healthy" }] as ChannelAccount[];
    const channels = [{ id: "deepseek", name: "DeepSeek" }] as ChannelPreset[];
    const routes = [
      { id: "r2", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "anthropic", priority: 1, enabled: true },
      { id: "r1", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", priority: 0, enabled: true },
    ] as RouteCandidate[];

    const models = buildModelServiceItems(routes, accounts, channels);

    expect(models.map((model) => model.publicModel)).toEqual([
      "flowlet-pro",
      "flowlet-flash",
      "deepseek-v4-pro",
    ]);
    expect(models.find((model) => model.publicModel === "deepseek-v4-pro")).toEqual(
      expect.objectContaining({
        publicModel: "deepseek-v4-pro",
        channelName: "DeepSeek",
        enabled: true,
        available: true,
        availableAccountCount: 1,
        routeIds: ["r2", "r1"],
        routes: [expect.objectContaining({ id: "r1" }), expect.objectContaining({ id: "r2" })],
        routeGroups: [expect.objectContaining({
          routeIds: ["r2", "r1"],
          upstreamModel: "deepseek-v4-pro",
          enabled: true,
        })],
      }),
    );
  });

  it("always includes the default Flowlet aggregate models without routes", () => {
    expect(buildModelServiceItems([], [], []).map((model) => model.publicModel)).toEqual([
      "flowlet-pro",
      "flowlet-flash",
    ]);
  });
});
