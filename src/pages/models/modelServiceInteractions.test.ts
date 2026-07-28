import { describe, expect, it } from "vitest";
import type { RouteCandidate } from "../../domains/model/types";
import type { ModelServiceItem } from "./modelServiceView";
import { filterModelServiceItems, reorderModelRouteGroups } from "./modelServiceInteractions";

function route(
  id: string,
  modelId: string,
  channelId: string,
  accountId: string,
  protocol: "openai" | "anthropic",
  priority: number,
): RouteCandidate {
  return {
    id,
    virtual_model_id: modelId,
    channel_id: channelId,
    account_id: accountId,
    upstream_model: `${channelId}-model`,
    client_protocol: protocol,
    priority,
    enabled: true,
    created_at: "created",
    updated_at: "old",
  };
}

describe("model service interactions", () => {
  it("filters aggregate and direct models by route channel", () => {
    const models = [
      {
        publicModel: "flowlet-pro",
        enabled: true,
        routes: [route("r1", "flowlet-pro", "kimi", "a1", "openai", 0)],
      },
      {
        publicModel: "deepseek-v4-pro",
        enabled: true,
        routes: [route("r2", "deepseek-v4-pro", "deepseek", "a2", "openai", 0)],
      },
    ] as ModelServiceItem[];

    expect(filterModelServiceItems(models, "", "all", "kimi").map((model) => model.publicModel))
      .toEqual(["flowlet-pro"]);
    expect(filterModelServiceItems(models, "", "all", "deepseek").map((model) => model.publicModel))
      .toEqual(["deepseek-v4-pro"]);
  });

  it("filters by availability, enabled state and aggregate membership", () => {
    const models = [
      { publicModel: "flowlet-pro", kind: "aggregate", enabled: true, available: false, routes: [], routeIds: [], routeGroups: [], availableAccountCount: 0 },
      { publicModel: "deepseek-v4-pro", kind: "direct", enabled: false, available: true, routes: [], routeIds: [], routeGroups: [], availableAccountCount: 1 },
      { publicModel: "qwen3.7-plus", kind: "direct", enabled: false, available: true, routes: [], routeIds: [], routeGroups: [], availableAccountCount: 1 },
    ] as ModelServiceItem[];
    const relations = new Map([
      ["deepseek-v4-pro", [{ aggregateModel: "flowlet-pro", routeGroupKey: "k", priority: 1, enabled: true }]],
    ]);

    expect(filterModelServiceItems(models, "", "available", "all", relations).map((model) => model.publicModel))
      .toEqual(["deepseek-v4-pro", "qwen3.7-plus"]);
    expect(filterModelServiceItems(models, "", "enabled", "all", relations).map((model) => model.publicModel))
      .toEqual(["flowlet-pro"]);
    expect(filterModelServiceItems(models, "", "not-routed", "all", relations).map((model) => model.publicModel))
      .toEqual(["qwen3.7-plus"]);
  });

  it("moves a route group and keeps both protocols at the same priority", () => {
    const routes = [
      route("kimi-openai", "flowlet-pro", "kimi", "kimi-account", "openai", 0),
      route("kimi-anthropic", "flowlet-pro", "kimi", "kimi-account", "anthropic", 0),
      route("deepseek-openai", "flowlet-pro", "deepseek", "deepseek-account", "openai", 1),
      route("direct", "deepseek-v4-pro", "deepseek", "deepseek-account", "openai", 9),
    ];
    const kimiKey = ["kimi", "kimi-account", "kimi-model"].join("\u0000");
    const deepseekKey = ["deepseek", "deepseek-account", "deepseek-model"].join("\u0000");

    const reordered = reorderModelRouteGroups(
      routes,
      "flowlet-pro",
      deepseekKey,
      kimiKey,
      "updated",
    );

    expect(reordered.find((item) => item.id === "deepseek-openai")?.priority).toBe(0);
    expect(reordered.filter((item) => item.id.startsWith("kimi-")).map((item) => item.priority))
      .toEqual([1, 1]);
    expect(reordered.find((item) => item.id === "direct")).toEqual(routes[3]);
  });

  it("returns the original array for an unknown drag target", () => {
    const routes = [route("r1", "flowlet-pro", "kimi", "a1", "openai", 0)];
    expect(reorderModelRouteGroups(routes, "flowlet-pro", "missing", "also-missing", "updated"))
      .toBe(routes);
  });
});
