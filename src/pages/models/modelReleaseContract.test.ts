import { describe, expect, it } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { mergeDefaultRoutes, reconcileAccountRoutes } from "../../domains/model/commands";
import { modelKindFor } from "../../domains/modelCatalog/identity";
import { computeAvailableModels } from "../../features/agent-access/availableModels";
import { buildModelServiceItems } from "./modelServiceView";

describe("released model integration contract", () => {
  it("keeps HY4, Flash and decision models visible with independent protocol pools", () => {
    const ids = ["hy4", "hy4-flash", "decision-model-preview"];
    const account = {
      id: "relay", channel_id: "custom", api_key: "test", enabled: true,
      credential_status: "healthy", base_url_override: "https://gateway.example/v1",
      synced_models: ids, exposed_models: ids,
    } as ChannelAccount;
    const preset = {
      id: "custom", vendor: "custom", name: "Relay",
      supported_protocols: ["openai", "anthropic", "responses", "systemone"],
    } as ChannelPreset;
    account.anthropic_base_url_override = "https://gateway.example";
    const routes = mergeDefaultRoutes([], [account], [preset]);
    expect(routes).toHaveLength(7);
    expect(routes.filter((route) => route.virtual_model_id === "decision-model-preview")
      .map((route) => route.client_protocol)).toEqual(["systemone"]);
    const items = buildModelServiceItems(routes, [account], [preset]);
    expect(items.map((item) => item.publicModel).sort()).toEqual([...ids].sort());
    expect(items.every((item) => item.available)).toBe(true);
    const badChatRoute = { ...routes.find((r) => r.virtual_model_id === "decision-model-preview")!, id: "old-bad-chat", client_protocol: "openai" as const };
    expect(computeAvailableModels([...routes, badChatRoute], [account], [preset])
      .map((item) => item.model).sort()).toEqual(["hy4", "hy4-flash"]);
    expect(modelKindFor("decision-model-preview")).toBe("decision");
    expect(reconcileAccountRoutes(routes, [{ ...account, exposed_models: ["hy4", "hy4-flash"] }], [preset])
      .every((route) => route.virtual_model_id !== "decision-model-preview")).toBe(true);
  });
});
