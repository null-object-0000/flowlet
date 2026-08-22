import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../account/types";
import type { ChannelPreset } from "../channel/types";
import { resolveSelectedUpstreamModelIds } from "../channel/types";
import type { RouteCandidate } from "./types";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { mergeDefaultRoutes, modelCommands, reconcileAccountRoutes, routesDiffer } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("upstream resource selection", () => {
  it("keeps independently selected raw IDs for one canonical model", () => {
    expect(resolveSelectedUpstreamModelIds(
      ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
      ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    )).toEqual(["deepseek-v4-flash", "deepseek-v4-flash-0731"]);
  });

  it("maps a legacy canonical-only selection to the alias when it is the only synced resource", () => {
    expect(resolveSelectedUpstreamModelIds(
      ["deepseek-v4-flash"],
      ["deepseek-v4-flash-0731"],
    )).toEqual(["deepseek-v4-flash-0731"]);
  });

  it("does not implicitly select the alias when the exact canonical resource exists", () => {
    expect(resolveSelectedUpstreamModelIds(
      ["deepseek-v4-flash"],
      ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    )).toEqual(["deepseek-v4-flash"]);
  });
});

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
  // 默认给账号配上与白名单一致的用户勾选，模拟「已选好开放模型」的账号。
  const account = {
    id: "account-deepseek",
    channel_id: "deepseek",
    api_key: "sk-test",
    enabled: true,
    exposed_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    synced_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  } as ChannelAccount;
  const preset = {
    id: "deepseek",
    supported_protocols: ["openai", "anthropic"],
  } as ChannelPreset;

  it("creates only direct routes for both protocols", () => {
    const routes = mergeDefaultRoutes([], [account], [preset]);
    expect(routes).toHaveLength(4);
    expect(routes.map((route) => [route.virtual_model_id, route.client_protocol])).toEqual([
      ["deepseek-v4-flash", "openai"],
      ["deepseek-v4-pro", "openai"],
      ["deepseek-v4-flash", "anthropic"],
      ["deepseek-v4-pro", "anthropic"],
    ]);
    expect(new Set(routes.map((route) => route.id))).toHaveLength(4);
    expect(routes.some((route) => route.virtual_model_id.startsWith("flowlet-"))).toBe(false);
    expect(routes.every((route) => route.enabled)).toBe(true);
  });

  it("keeps later accounts in routing but disables all of their new routes", () => {
    const firstAccount = {
      ...account,
      id: "account-first",
      created_at: "2026-07-01T00:00:00Z",
    } as ChannelAccount;
    const laterAccount = {
      ...account,
      id: "account-later",
      created_at: "2026-07-02T00:00:00Z",
    } as ChannelAccount;

    // 故意把后创建账号放在数组前面，验证判定基于全局创建时间而非渠道/数组排序。
    const routes = mergeDefaultRoutes([], [laterAccount, firstAccount], [preset]);
    const firstRoutes = routes.filter((route) => route.account_id === firstAccount.id);
    const laterRoutes = routes.filter((route) => route.account_id === laterAccount.id);

    expect(firstRoutes.length).toBeGreaterThan(0);
    expect(firstRoutes.every((route) => route.enabled)).toBe(true);
    expect(laterRoutes.length).toBeGreaterThan(0);
    expect(laterRoutes.every((route) => !route.enabled)).toBe(true);
  });

  it("produces no routes for an account never configured in the new flow (exposed_models = null)", () => {
    const unconfigured = { ...account, exposed_models: null } as ChannelAccount;
    expect(mergeDefaultRoutes([], [unconfigured], [preset])).toHaveLength(0);
  });

  it("produces no routes for an account with an empty selection", () => {
    const noneSelected = { ...account, exposed_models: [] } as ChannelAccount;
    expect(mergeDefaultRoutes([], [noneSelected], [preset])).toHaveLength(0);
  });

  it("intersects the whitelist with the selected models", () => {
    // 白名单外（deepseek-chat）被过滤；白名单内但未勾选的（deepseek-v4-pro）也不生成。
    const partial = {
      ...account,
      exposed_models: ["deepseek-v4-flash", "deepseek-chat"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [partial], [preset]);
    const upstreamModels = new Set(routes.map((route) => route.upstream_model));
    expect(upstreamModels).toEqual(new Set(["deepseek-v4-flash"]));
    expect(upstreamModels.has("deepseek-v4-pro")).toBe(false);
    expect(upstreamModels.has("deepseek-chat")).toBe(false);
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
    expect(routes).toHaveLength(4);
    expect(routes[0]).toBe(existing[0]);
  });

  it("does not infer aggregate membership for LongCat-2.0", () => {
    const longcatAccount = {
      ...account,
      id: "account-longcat",
      channel_id: "longcat",
      exposed_models: ["LongCat-2.0"],
      synced_models: ["LongCat-2.0"],
    } as ChannelAccount;
    const longcatPreset = {
      id: "longcat",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;

    const routes = mergeDefaultRoutes([], [longcatAccount], [longcatPreset]);
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => [route.virtual_model_id, route.client_protocol])).toEqual([
      ["LongCat-2.0", "openai"],
      ["LongCat-2.0", "anthropic"],
    ]);
  });

  it("uses the global supported-models set (not per-channel), so any account may expose any supported model", () => {
    const qwenPreset = {
      id: "qwen",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;
    const deepseekPreset = {
      id: "deepseek",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;
    const paygAccount = {
      ...account,
      id: "account-qwen-payg",
      channel_id: "qwen",
      resource_mode: "pay_as_you_go",
      exposed_models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"],
      synced_models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"],
    } as ChannelAccount;
    const planAccount = {
      ...account,
      id: "account-qwen-plan",
      channel_id: "qwen",
      resource_mode: "token_plan",
      exposed_models: ["qwen3.8-max", "qwen3.6-flash"],
      synced_models: ["qwen3.8-max", "qwen3.6-flash"],
    } as ChannelAccount;

    const paygRoutes = mergeDefaultRoutes([], [paygAccount], [qwenPreset]);
    expect(new Set(paygRoutes.map((route) => route.upstream_model))).toEqual(new Set(["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"]));

    const planRoutes = mergeDefaultRoutes([], [planAccount], [qwenPreset]);
    expect(new Set(planRoutes.map((route) => route.upstream_model))).toEqual(new Set(["qwen3.8-max", "qwen3.6-flash"]));
    expect(planRoutes.some((route) => route.virtual_model_id.startsWith("flowlet-"))).toBe(false);

    // 跨渠道：千问账号勾选原属 DeepSeek 的 deepseek-v4-pro，全局白名单下仍可开放为直连模型。
    const crossChannelAccount = {
      ...account,
      id: "account-qwen-cross",
      channel_id: "qwen",
      exposed_models: ["deepseek-v4-pro", "qwen3.6-flash"],
      synced_models: ["deepseek-v4-pro", "qwen3.6-flash"],
    } as ChannelAccount;
    const crossRoutes = mergeDefaultRoutes([], [crossChannelAccount], [qwenPreset, deepseekPreset]);
    const crossUpstream = new Set(crossRoutes.map((route) => route.upstream_model));
    expect(crossUpstream).toEqual(new Set(["deepseek-v4-pro", "qwen3.6-flash"]));
    expect(crossRoutes.some((route) => route.virtual_model_id === "deepseek-v4-pro" && route.upstream_model === "deepseek-v4-pro")).toBe(true);
  });

  it("applies the global model whitelist to custom channels and only builds configured protocols", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;
    const customAccount = {
      ...account,
      id: "account-custom",
      channel_id: "custom",
      base_url_override: "https://relay.example/v1",
      anthropic_base_url_override: null,
      exposed_models: ["deepseek-v4-pro", "relay-proprietary-model"],
      synced_models: ["deepseek-v4-pro", "relay-proprietary-model"],
    } as ChannelAccount;

    const routes = mergeDefaultRoutes([], [customAccount], [customPreset]);
    expect(new Set(routes.map((route) => route.upstream_model))).toEqual(new Set(["deepseek-v4-pro"]));
    expect(routes.every((route) => route.client_protocol === "openai")).toBe(true);
    expect(routes.some((route) => route.upstream_model === "relay-proprietary-model")).toBe(false);
  });

  it("also creates custom-channel routes disabled when another account already exists", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai"],
    } as ChannelPreset;
    const firstOfficialAccount = {
      ...account,
      id: "account-first-official",
      created_at: "2026-07-01T00:00:00Z",
    } as ChannelAccount;
    const laterCustomAccount = {
      ...account,
      id: "account-later-custom",
      channel_id: "custom",
      base_url_override: "https://relay.example/v1",
      anthropic_base_url_override: null,
      exposed_models: ["deepseek-v4-pro"],
      synced_models: ["deepseek-v4-pro"],
      created_at: "2026-07-02T00:00:00Z",
    } as ChannelAccount;

    const routes = mergeDefaultRoutes(
      [],
      [laterCustomAccount, firstOfficialAccount],
      [customPreset],
    );

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.account_id === laterCustomAccount.id)).toBe(true);
    expect(routes.every((route) => !route.enabled)).toBe(true);
  });

  it("does not build a route for a supported model missing from the account's latest /models result", () => {
    const staleSelection = {
      ...account,
      exposed_models: ["deepseek-v4-pro"],
      synced_models: ["deepseek-v4-flash"],
    } as ChannelAccount;

    expect(mergeDefaultRoutes([], [staleSelection], [preset])).toHaveLength(0);
  });
});

describe("alias variant mapping (deepseek-v4-flash-0731 → deepseek-v4-flash)", () => {
  const qwenPreset = {
    id: "qwen",
    supported_protocols: ["openai"],
  } as ChannelPreset;
  const tokenPlanAccount = {
    id: "account-qwen-token-plan",
    channel_id: "qwen",
    api_key: "sk-sp-test",
    enabled: true,
    exposed_models: ["deepseek-v4-flash"],
    synced_models: ["deepseek-v4-flash-0731"],
  } as ChannelAccount;

  it("maps an aliased /models variant to the canonical virtual model and keeps the raw upstream name", () => {
    const routes = mergeDefaultRoutes([], [tokenPlanAccount], [qwenPreset]);
    expect(routes.map((route) => [route.virtual_model_id, route.upstream_model])).toEqual([
      ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    ]);
    expect(new Set(routes.map((route) => route.id))).toHaveLength(1);
  });

  it("selects only the exact upstream resource when only the canonical ID is checked", () => {
    const account = {
      ...tokenPlanAccount,
      synced_models: ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [account], [qwenPreset]);
    expect(routes.every((route) => route.upstream_model === "deepseek-v4-flash")).toBe(true);
    expect(routes).toHaveLength(1);
  });

  it("selects only the alias upstream resource when its raw ID is checked", () => {
    const account = {
      ...tokenPlanAccount,
      exposed_models: ["deepseek-v4-flash-0731"],
      synced_models: ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [account], [qwenPreset]);
    expect(routes.map((route) => [route.virtual_model_id, route.upstream_model])).toEqual([
      ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    ]);
  });

  it("keeps canonical and alias IDs as two independent candidates when both are checked", () => {
    const account = {
      ...tokenPlanAccount,
      exposed_models: ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
      synced_models: ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [account], [qwenPreset]);
    expect(routes.map((route) => [route.virtual_model_id, route.upstream_model])).toEqual([
      ["deepseek-v4-flash", "deepseek-v4-flash"],
      ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    ]);
    expect(new Set(routes.map((route) => route.id))).toHaveLength(2);
  });

  it("does not build a route when the canonical model is not selected", () => {
    const account = {
      ...tokenPlanAccount,
      exposed_models: ["qwen3.6-flash"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [account], [qwenPreset]);
    expect(routes.some((route) => route.upstream_model === "deepseek-v4-flash-0731")).toBe(false);
  });

  it("keeps an alias-variant route through reconciliation while selected and synced", () => {
    const existing: RouteCandidate = {
      id: "route-account-qwen-token-plan-deepseek-v4-flash-0731-openai-0-0",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "qwen",
      account_id: "account-qwen-token-plan",
      upstream_model: "deepseek-v4-flash-0731",
      client_protocol: "openai",
      priority: 0,
      enabled: false,
      created_at: "old",
      updated_at: "old",
    };
    const next = reconcileAccountRoutes([existing], [tokenPlanAccount], [qwenPreset]);
    // 保留原路由（含启停状态），不产生重复路由。
    expect(next).toHaveLength(1);
    const kept = next.find((route) => route.id === existing.id);
    expect(kept?.enabled).toBe(false);
    expect(
      next.filter((route) => route.upstream_model === "deepseek-v4-flash-0731"),
    ).toHaveLength(1);
  });

  it("removes an alias-variant route when the canonical model is deselected", () => {
    const account = {
      ...tokenPlanAccount,
      exposed_models: [] as string[],
    } as ChannelAccount;
    const existing: RouteCandidate = {
      id: "route-alias",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "qwen",
      account_id: "account-qwen-token-plan",
      upstream_model: "deepseek-v4-flash-0731",
      client_protocol: "openai",
      priority: 0,
      enabled: true,
      created_at: "old",
      updated_at: "old",
    };
    const next = reconcileAccountRoutes([existing], [account], [qwenPreset]);
    expect(next.some((route) => route.upstream_model === "deepseek-v4-flash-0731")).toBe(false);
  });

  it("removes only the unchecked upstream resource while keeping its sibling candidate", () => {
    const account = {
      ...tokenPlanAccount,
      exposed_models: ["deepseek-v4-flash-0731"],
      synced_models: ["deepseek-v4-flash", "deepseek-v4-flash-0731"],
    } as ChannelAccount;
    const existing = [
      {
        id: "route-canonical",
        virtual_model_id: "deepseek-v4-flash",
        channel_id: "qwen",
        account_id: account.id,
        upstream_model: "deepseek-v4-flash",
        client_protocol: "openai",
        priority: 3,
        enabled: true,
        created_at: "old",
        updated_at: "old",
      },
      {
        id: "route-alias",
        virtual_model_id: "deepseek-v4-flash",
        channel_id: "qwen",
        account_id: account.id,
        upstream_model: "deepseek-v4-flash-0731",
        client_protocol: "openai",
        priority: 4,
        enabled: false,
        created_at: "old",
        updated_at: "old",
      },
    ] as RouteCandidate[];

    const next = reconcileAccountRoutes(existing, [account], [qwenPreset]);
    expect(next.some((route) => route.id === "route-canonical")).toBe(false);
    expect(next.find((route) => route.id === "route-alias")).toMatchObject({
      enabled: false,
      priority: 4,
    });
  });
});

describe("OpenRouter aggregate channel (vendor/model IDs)", () => {
  const openrouterPreset = {
    id: "openrouter",
    vendor: "openrouter",
    supported_protocols: ["openai", "anthropic", "responses"],
  } as ChannelPreset;
  const account = {
    id: "account-openrouter",
    channel_id: "openrouter",
    api_key: "sk-or-test",
    enabled: true,
    exposed_models: ["deepseek/deepseek-v4-flash", "qwen/qwen3.7-max", "z-ai/glm-5.2", "stealth/ox-alpha"],
    synced_models: ["deepseek/deepseek-v4-flash", "qwen/qwen3.7-max", "z-ai/glm-5.2", "stealth/ox-alpha"],
  } as ChannelAccount;

  it("maps vendor-prefixed upstream IDs to canonical whitelist models", () => {
    const routes = mergeDefaultRoutes([], [account], [openrouterPreset]);
    const pairs = routes.map((route) => [route.virtual_model_id, route.upstream_model] as const);
    // 每个声明的协议（openai / anthropic / responses）各生成四个直连路由，按勾选顺序排列。
    expect(pairs).toEqual([
      ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
      ["qwen3.7-max", "qwen/qwen3.7-max"],
      ["glm-5.2", "z-ai/glm-5.2"],
      ["ox-alpha", "stealth/ox-alpha"],
      ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
      ["qwen3.7-max", "qwen/qwen3.7-max"],
      ["glm-5.2", "z-ai/glm-5.2"],
      ["ox-alpha", "stealth/ox-alpha"],
      ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
      ["qwen3.7-max", "qwen/qwen3.7-max"],
      ["glm-5.2", "z-ai/glm-5.2"],
      ["ox-alpha", "stealth/ox-alpha"],
    ]);
    expect(routes.every((route) => route.channel_id === "openrouter")).toBe(true);
    // responses 协议确实生成路由。
    expect(new Set(routes.map((route) => route.client_protocol))).toEqual(
      new Set(["openai", "anthropic", "responses"]),
    );
  });

  it("filters vendor-prefixed models outside the Flowlet whitelist", () => {
    const withStranger = {
      ...account,
      exposed_models: ["deepseek/deepseek-v4-flash", "openai/gpt-5.5"],
      synced_models: ["deepseek/deepseek-v4-flash", "openai/gpt-5.5"],
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [withStranger], [openrouterPreset]);
    const upstreams = new Set(routes.map((route) => route.upstream_model));
    expect(upstreams).toEqual(new Set(["deepseek/deepseek-v4-flash"]));
  });

  it("maps NVIDIA free resource IDs to stable public model IDs", () => {
    const nvidiaModels = [
      "nvidia/nemotron-3.5-lightning:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ];
    const nvidiaAccount = {
      ...account,
      exposed_models: nvidiaModels,
      synced_models: nvidiaModels,
    } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [nvidiaAccount], [openrouterPreset]);
    expect(new Set(routes.map((route) => route.virtual_model_id))).toEqual(new Set([
      "nemotron-3.5-lightning",
      "nemotron-3-super-120b-a12b",
      "nemotron-3-ultra-550b-a55b",
    ]));
    expect(new Set(routes.map((route) => route.upstream_model))).toEqual(new Set(nvidiaModels));
    expect(routes).toHaveLength(9);
  });

  it("keeps vendor-prefixed routes through reconciliation while selected and synced", () => {
    const existing: RouteCandidate = {
      id: "route-account-openrouter-deepseek/deepseek-v4-flash-openai-0-0",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "openrouter",
      account_id: "account-openrouter",
      upstream_model: "deepseek/deepseek-v4-flash",
      client_protocol: "openai",
      priority: 0,
      enabled: false,
      created_at: "old",
      updated_at: "old",
    };
    const next = reconcileAccountRoutes([existing], [account], [openrouterPreset]);
    expect(next.find((route) => route.id === existing.id)?.enabled).toBe(false);
    expect(next.some((route) => route.upstream_model === "deepseek/deepseek-v4-flash")).toBe(true);
  });
});

describe("reconcileAccountRoutes", () => {
  const preset = {
    id: "deepseek",
    supported_protocols: ["openai", "anthropic"],
  } as ChannelPreset;

  function route(upstream: string, protocol: "openai" | "anthropic", extra: Partial<RouteCandidate> = {}): RouteCandidate {
    return {
      id: `route-${upstream}-${protocol}`,
      virtual_model_id: upstream,
      channel_id: "deepseek",
      account_id: "account-deepseek",
      upstream_model: upstream,
      client_protocol: protocol,
      priority: 0,
      enabled: true,
      created_at: "old",
      updated_at: "old",
      ...extra,
    };
  }

  it("leaves routes untouched for accounts not configured in the new flow (null)", () => {
    const account = {
      id: "account-deepseek",
      channel_id: "deepseek",
      api_key: "sk-test",
      enabled: true,
      exposed_models: null,
    } as ChannelAccount;
    const existing = [route("deepseek-v4-flash", "openai"), route("deepseek-v4-pro", "anthropic")];
    const next = reconcileAccountRoutes(existing, [account], [preset]);
    // null = 保持现状：不增不删。
    expect(next.map((item) => item.id)).toEqual(existing.map((item) => item.id));
  });

  it("removes routes for deselected models and adds routes for selected ones", () => {
    const account = {
      id: "account-deepseek",
      channel_id: "deepseek",
      api_key: "sk-test",
      enabled: true,
      exposed_models: ["deepseek-v4-pro"],
      synced_models: ["deepseek-v4-pro"],
    } as ChannelAccount;
    const existing = [
      route("deepseek-v4-flash", "openai"),
      route("deepseek-v4-flash", "anthropic"),
      route("deepseek-v4-pro", "openai", { enabled: false, priority: 7 }),
    ];
    const next = reconcileAccountRoutes(existing, [account], [preset]);
    // flash 路由被删除；pro 已有路由保留（含启停/优先级）；pro 的 anthropic 与 flowlet 聚合路由补齐。
    expect(next.some((item) => item.upstream_model === "deepseek-v4-flash")).toBe(false);
    const kept = next.find((item) => item.id === "route-deepseek-v4-pro-openai");
    expect(kept?.enabled).toBe(false);
    expect(kept?.priority).toBe(7);
    expect(next.some((item) => item.upstream_model === "deepseek-v4-pro" && item.client_protocol === "anthropic")).toBe(true);
  });

  it("clears every route of an account with an empty selection", () => {
    const account = {
      id: "account-deepseek",
      channel_id: "deepseek",
      api_key: "sk-test",
      enabled: true,
      exposed_models: [] as string[],
      synced_models: [] as string[],
    } as ChannelAccount;
    const existing = [route("deepseek-v4-flash", "openai"), route("deepseek-v4-pro", "anthropic")];
    const next = reconcileAccountRoutes(existing, [account], [preset]);
    expect(next.filter((item) => item.account_id === "account-deepseek")).toHaveLength(0);
  });

  it("removes custom-channel routes when their protocol Base URL is cleared", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;
    const customAccount = {
      id: "account-custom",
      channel_id: "custom",
      api_key: "sk-test",
      enabled: true,
      base_url_override: "https://relay.example/v1",
      anthropic_base_url_override: null,
      exposed_models: ["deepseek-v4-pro"],
      synced_models: ["deepseek-v4-pro"],
    } as ChannelAccount;
    const existing = [{
      ...route("deepseek-v4-pro", "anthropic"),
      channel_id: "custom",
      account_id: "account-custom",
    }];

    const next = reconcileAccountRoutes(existing, [customAccount], [customPreset]);
    expect(next.some((item) => item.client_protocol === "anthropic")).toBe(false);
    expect(next.some((item) => item.client_protocol === "openai")).toBe(true);
  });

  it("removes an existing custom-channel route for an unsupported model", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai"],
    } as ChannelPreset;
    const customAccount = {
      id: "account-custom",
      channel_id: "custom",
      api_key: "sk-test",
      enabled: true,
      base_url_override: "https://relay.example/v1",
      exposed_models: ["relay-model"],
      synced_models: ["relay-model"],
    } as ChannelAccount;
    const unsupported = [{
      ...route("relay-model", "openai"),
      channel_id: "custom",
      account_id: "account-custom",
    }];

    expect(reconcileAccountRoutes(unsupported, [customAccount], [customPreset])).toHaveLength(0);
  });

  it("removes an existing route when the model disappeared from the latest /models result", () => {
    const account = {
      id: "account-deepseek",
      channel_id: "deepseek",
      api_key: "sk-test",
      enabled: true,
      exposed_models: ["deepseek-v4-pro"],
      synced_models: ["deepseek-v4-flash"],
    } as ChannelAccount;

    expect(reconcileAccountRoutes([route("deepseek-v4-pro", "openai")], [account], [preset])).toHaveLength(0);
  });

  it("keeps routes of unknown accounts (deleted elsewhere) untouched", () => {
    const account = {
      id: "account-deepseek",
      channel_id: "deepseek",
      api_key: "sk-test",
      enabled: true,
      exposed_models: [] as string[],
      synced_models: [] as string[],
    } as ChannelAccount;
    const orphan = route("deepseek-v4-flash", "openai", { account_id: "account-removed" });
    const next = reconcileAccountRoutes([orphan], [account], [preset]);
    expect(next.some((item) => item.id === orphan.id)).toBe(true);
  });
});

describe("responses protocol routing", () => {
  const account = {
    id: "account-deepseek",
    channel_id: "deepseek",
    api_key: "sk-test",
    enabled: true,
    exposed_models: ["deepseek-v4-flash"],
    synced_models: ["deepseek-v4-flash"],
  } as ChannelAccount;

  it("generates responses routes for channels declaring the protocol", () => {
    const preset = {
      id: "deepseek",
      supported_protocols: ["openai", "anthropic", "responses"],
    } as ChannelPreset;
    const routes = mergeDefaultRoutes([], [account], [preset]);
    expect(routes).toHaveLength(3);
    const responsesRoutes = routes.filter((route) => route.client_protocol === "responses");
    expect(responsesRoutes.map((route) => route.virtual_model_id)).toEqual(["deepseek-v4-flash"]);
  });

  it("generates no responses routes for channels without the protocol (Kimi)", () => {
    const preset = {
      id: "kimi",
      supported_protocols: ["openai", "anthropic"],
    } as ChannelPreset;
    const kimiAccount = { ...account, channel_id: "kimi" } as ChannelAccount;
    const routes = mergeDefaultRoutes([], [kimiAccount], [preset]);
    expect(routes.some((route) => route.client_protocol === "responses")).toBe(false);
  });

  it("requires the OpenAI Base URL override for custom-channel responses routes", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai", "responses"],
    } as ChannelPreset;
    const withUrl = {
      ...account,
      id: "account-custom",
      channel_id: "custom",
      base_url_override: "https://relay.example/v1",
    } as ChannelAccount;
    const protocols = new Set(
      mergeDefaultRoutes([], [withUrl], [customPreset]).map((route) => route.client_protocol),
    );
    expect(protocols).toEqual(new Set(["openai", "responses"]));

    const withoutUrl = { ...withUrl, base_url_override: null } as ChannelAccount;
    expect(mergeDefaultRoutes([], [withoutUrl], [customPreset])).toHaveLength(0);
  });

  it("prunes custom-channel responses routes when the Base URL override is cleared", () => {
    const customPreset = {
      id: "custom",
      vendor: "custom",
      supported_protocols: ["openai", "responses"],
    } as ChannelPreset;
    const customAccount = {
      ...account,
      id: "account-custom",
      channel_id: "custom",
      base_url_override: null,
    } as ChannelAccount;
    const existing: RouteCandidate = {
      id: "route-responses",
      virtual_model_id: "deepseek-v4-flash",
      channel_id: "custom",
      account_id: "account-custom",
      upstream_model: "deepseek-v4-flash",
      client_protocol: "responses",
      priority: 0,
      enabled: true,
      created_at: "old",
      updated_at: "old",
    };
    expect(reconcileAccountRoutes([existing], [customAccount], [customPreset])).toHaveLength(0);
  });
});

describe("routesDiffer", () => {
  const base: RouteCandidate = {
    id: "route-1",
    virtual_model_id: "deepseek-v4-flash",
    channel_id: "deepseek",
    account_id: "account-deepseek",
    upstream_model: "deepseek-v4-flash",
    client_protocol: "openai",
    priority: 0,
    enabled: true,
    created_at: "old",
    updated_at: "old",
  };

  it("treats the same multiset in different order as equal", () => {
    const a: RouteCandidate[] = [base, { ...base, id: "route-2", client_protocol: "anthropic" }];
    const b: RouteCandidate[] = [{ ...base, id: "route-2", client_protocol: "anthropic" }, base];
    expect(routesDiffer(a, b)).toBe(false);
  });

  it("detects added or removed routes", () => {
    const a: RouteCandidate[] = [base];
    const b: RouteCandidate[] = [base, { ...base, id: "route-2", client_protocol: "anthropic" }];
    expect(routesDiffer(a, b)).toBe(true);
  });

  it("ignores priority / enabled differences (identity is the signature)", () => {
    const a = [base];
    const b = [{ ...base, enabled: false, priority: 9 }];
    expect(routesDiffer(a, b)).toBe(false);
  });
});
