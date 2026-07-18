import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../account/types";
import type { ChannelPreset } from "../channel/types";
import type { RouteCandidate } from "./types";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { mergeDefaultRoutes, modelCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("modelCommands contract", () => {
  it("saves the complete candidate list through save_route_candidates", async () => {
    const routes = [{ id: "route-1", enabled: false }];
    await modelCommands.saveRouteCandidates(routes as never);
    expect(invokeMock).toHaveBeenCalledWith("save_route_candidates", { routes });
  });

  it("lists the current candidate routes", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await expect(modelCommands.listRouteCandidates()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("list_route_candidates", undefined);
  });
});

describe("mergeDefaultRoutes", () => {
  const account = {
    id: "account-deepseek",
    channel_id: "deepseek",
    api_key: "sk-test",
    enabled: true,
  } as ChannelAccount;
  const preset = {
    id: "deepseek",
    supported_protocols: ["openai", "anthropic"],
  } as ChannelPreset;

  it("creates direct and Flowlet aggregate routes for both protocols", () => {
    const routes = mergeDefaultRoutes([], [account], [preset]);
    expect(routes).toHaveLength(8);
    expect(routes.map((route) => [route.virtual_model_id, route.client_protocol])).toEqual([
      ["deepseek-v4-flash", "openai"],
      ["flowlet-flash", "openai"],
      ["deepseek-v4-pro", "openai"],
      ["flowlet-pro", "openai"],
      ["deepseek-v4-flash", "anthropic"],
      ["flowlet-flash", "anthropic"],
      ["deepseek-v4-pro", "anthropic"],
      ["flowlet-pro", "anthropic"],
    ]);
    expect(new Set(routes.map((route) => route.id))).toHaveLength(8);
  });

  it("preserves an existing disabled route and adds only missing routes", () => {
    const existing = [{
      id: "existing-route",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "deepseek",
      account_id: account.id,
      upstream_model: "deepseek-v4-flash",
      client_protocol: "openai",
      priority: 9,
      enabled: false,
      created_at: "old",
      updated_at: "old",
    }] as RouteCandidate[];
    const routes = mergeDefaultRoutes(existing, [account], [preset]);
    expect(routes).toHaveLength(8);
    expect(routes[0]).toBe(existing[0]);
  });

  it("maps LongCat-2.0 into both Flowlet aggregate tiers", () => {
    const longcatAccount = {
      ...account,
      id: "account-longcat",
      channel_id: "longcat",
    } as ChannelAccount;
    const longcatPreset = {
      id: "longcat",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;

    const routes = mergeDefaultRoutes([], [longcatAccount], [longcatPreset]);
    expect(routes).toHaveLength(6);
    expect(routes.map((route) => [route.virtual_model_id, route.client_protocol])).toEqual([
      ["LongCat-2.0", "openai"],
      ["flowlet-pro", "openai"],
      ["flowlet-flash", "openai"],
      ["LongCat-2.0", "anthropic"],
      ["flowlet-pro", "anthropic"],
      ["flowlet-flash", "anthropic"],
    ]);
  });
});
