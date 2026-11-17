// System One 决策模型的 Node Host 路由生成契约。
// 运行：node --test packages/flowlet-core/src/config/__tests__/decision-routes.test.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ModelCatalogImpl, setDefaultModelCatalog } from "../../catalog/index.ts";
import { mergeDefaultRoutes } from "../index.ts";
import type { JsonRow } from "../../types.ts";

const CATALOG: JsonRow = {
  schemaVersion: 1,
  models: [
    { id: "qwen3.8-max", ownerChannelId: "qwen", modelsCnProviderId: "qwen-cn", aliases: [] },
    {
      id: "decision-model-preview",
      ownerChannelId: "qwen",
      modelsCnProviderId: "qwen-cn",
      aliases: [],
      kind: "decision",
    },
  ],
};

const PRESET: JsonRow = {
  id: "qwen",
  vendor: "qwen",
  supported_protocols: ["openai", "systemone"],
};

function account(overrides: JsonRow = {}): JsonRow {
  return {
    id: "account-qwen",
    channel_id: "qwen",
    name: "Qwen",
    api_key: "sk-sp-test",
    enabled: true,
    resource_mode: "token_plan",
    base_url_override: "https://token-plan.example/compatible-mode/v1",
    exposed_models: ["decision-model-preview", "qwen3.8-max"],
    synced_models: ["decision-model-preview", "qwen3.8-max"],
    created_at: "2026-11-16T00:00:00Z",
    ...overrides,
  };
}

before(() => {
  setDefaultModelCatalog(new ModelCatalogImpl(CATALOG, null, null));
});

after(() => {
  // 不把测试目录泄漏给同进程的其它测试文件。
  setDefaultModelCatalog(new ModelCatalogImpl({ schemaVersion: 1, models: [] }, null, null));
});

test("决策模型只生成 systemone 路由，对话模型不进入 systemone", () => {
  const routes = mergeDefaultRoutes([], [account()], [PRESET]);
  const byModel = new Map<string, string[]>();
  for (const route of routes) {
    const list = byModel.get(String(route.virtual_model_id)) ?? [];
    list.push(String(route.client_protocol));
    byModel.set(String(route.virtual_model_id), list);
  }
  assert.deepEqual(byModel.get("decision-model-preview"), ["systemone"]);
  assert.deepEqual(byModel.get("qwen3.8-max"), ["openai"]);
});

test("没有账号级网关地址时不生成 systemone 路由", () => {
  const routes = mergeDefaultRoutes(
    [],
    [
      account({
        id: "account-qwen-payg",
        resource_mode: "pay_as_you_go",
        base_url_override: null,
        workspace_default_base_url: null,
      }),
    ],
    [PRESET],
  );
  assert.equal(routes.some((route) => route.client_protocol === "systemone"), false);
  // 对话模型仍按 openai 正常生成。
  assert.equal(
    routes.some((route) => route.virtual_model_id === "qwen3.8-max" && route.client_protocol === "openai"),
    true,
  );
});

test("自定义渠道的账号级 Base URL 也可承载 systemone", () => {
  const routes = mergeDefaultRoutes(
    [],
    [
      {
        id: "account-friday",
        channel_id: "custom",
        name: "Friday",
        api_key: "sk-test",
        enabled: true,
        base_url_override: "https://oneai.example/v1",
        exposed_models: ["decision-model-preview"],
        synced_models: ["decision-model-preview"],
        created_at: "2026-11-16T00:00:00Z",
      },
    ],
    [{ id: "custom", vendor: "custom", supported_protocols: ["openai", "systemone"] }],
  );
  assert.deepEqual(
    routes.map((route) => [route.virtual_model_id, route.client_protocol]),
    [["decision-model-preview", "systemone"]],
  );
});

test("渠道未声明 systemone 时决策模型不生成任何路由", () => {
  const routes = mergeDefaultRoutes([], [account()], [{ ...PRESET, supported_protocols: ["openai"] }]);
  assert.equal(routes.some((route) => route.virtual_model_id === "decision-model-preview"), false);
});
