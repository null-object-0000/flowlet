import { describe, expect, it } from "vitest";
import type { RouteCandidate } from "../../domains/model/types";
import type { ModelServiceItem } from "./modelServiceView";
import {
  filterModelServiceItems,
  removeModelRouteGroup,
  reorderModelRouteGroups,
} from "./modelServiceInteractions";

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
  it("filters direct models by route channel", () => {
    const models = [
      {
        publicModel: "kimi-k3",
        enabled: true,
        routes: [route("r1", "kimi-k3", "kimi", "a1", "openai", 0)],
      },
      {
        publicModel: "deepseek-v4-pro",
        enabled: true,
        routes: [route("r2", "deepseek-v4-pro", "deepseek", "a2", "openai", 0)],
      },
    ] as ModelServiceItem[];

    expect(filterModelServiceItems(models, "", "kimi").map((model) => model.publicModel))
      .toEqual(["kimi-k3"]);
    expect(filterModelServiceItems(models, "", "deepseek").map((model) => model.publicModel))
      .toEqual(["deepseek-v4-pro"]);
  });

  it("filters by model name and upstream model", () => {
    const models = [
      {
        publicModel: "kimi-k3",
        routes: [route("r1", "kimi-k3", "kimi", "a1", "openai", 0)],
      },
      {
        publicModel: "deepseek-v4-pro",
        routes: [route("r2", "deepseek-v4-pro", "deepseek", "a2", "openai", 0)],
      },
    ] as ModelServiceItem[];

    expect(filterModelServiceItems(models, "KIMI", "all").map((model) => model.publicModel))
      .toEqual(["kimi-k3"]);
    expect(filterModelServiceItems(models, "deepseek-model", "all").map((model) => model.publicModel))
      .toEqual(["deepseek-v4-pro"]);
  });

  it("moves a route group and keeps both protocols at the same priority", () => {
    const routes = [
      route("kimi-openai", "kimi-k3", "kimi", "kimi-account", "openai", 0),
      route("kimi-anthropic", "kimi-k3", "kimi", "kimi-account", "anthropic", 0),
      route("qwen-openai", "kimi-k3", "qwen", "qwen-account", "openai", 1),
      route("direct", "deepseek-v4-pro", "deepseek", "deepseek-account", "openai", 9),
    ];
    const kimiKey = ["kimi", "kimi-account", "kimi-model"].join("\u0000");
    const qwenKey = ["qwen", "qwen-account", "qwen-model"].join("\u0000");

    const reordered = reorderModelRouteGroups(
      routes,
      "kimi-k3",
      qwenKey,
      kimiKey,
      "updated",
    );

    expect(reordered.find((item) => item.id === "qwen-openai")?.priority).toBe(0);
    expect(reordered.filter((item) => item.id.startsWith("kimi-")).map((item) => item.priority))
      .toEqual([1, 1]);
    expect(reordered.find((item) => item.id === "direct")).toEqual(routes[3]);
  });

  it("returns the original array for an unknown drag target", () => {
    const routes = [route("r1", "kimi-k3", "kimi", "a1", "openai", 0)];
    expect(reorderModelRouteGroups(routes, "kimi-k3", "missing", "also-missing", "updated"))
      .toBe(routes);
  });

  it("removes only the selected route group and compacts priorities", () => {
    const routes = [
      route("direct", "deepseek-v4-pro", "deepseek", "a1", "openai", 8),
      route("kimi-route", "kimi-k3", "kimi", "a1", "openai", 0),
      route("qwen-route", "kimi-k3", "qwen", "a2", "openai", 1),
    ];
    const next = removeModelRouteGroup(routes, "kimi-k3", ["kimi-route"]);
    expect(next.map((item) => item.id)).toEqual(["direct", "qwen-route"]);
    expect(next.find((item) => item.id === "qwen-route")?.priority).toBe(0);
    expect(next.find((item) => item.id === "direct")?.priority).toBe(8);
  });

  it("returns the original array when the route group is not exposed", () => {
    const routes = [route("r1", "kimi-k3", "kimi", "a1", "openai", 0)];
    expect(removeModelRouteGroup(routes, "kimi-k3", ["missing"])).toBe(routes);
  });
});