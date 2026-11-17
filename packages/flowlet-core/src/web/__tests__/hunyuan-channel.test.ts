// 腾讯混元（hunyuan / TokenHub）渠道接入契约测试。Owner: node-web.
//
// 覆盖新增渠道最容易漏掉的三段链路：
// 1. 仓库根目录 `config.json` 的渠道模板字段（协议、Base URL、端点、能力声明）真实可用；
// 2. 旧外部配置缺少该渠道时，内置模板合并后能把它补齐（升级路径）；
// 3. `model-catalog.json` 的模型身份与 models-cn provider 映射，决定 hy4 能生成路由并解析规格。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { channelsConfigToJson, loadChannelsConfig } from "../../config/index.ts";
import { modelsEndpointUrl } from "../config-state.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8")) as Record<string, unknown>;
}

describe("腾讯混元渠道（hunyuan / TokenHub）", () => {
  const config = readJson("config.json");
  const catalog = readJson("model-catalog.json") as {
    models: Array<{ id: string; ownerChannelId: string; modelsCnProviderId: string; aliases: string[] }>;
  };

  it("config.json 声明三协议、TokenHub 端点与 hy4 默认模型", () => {
    const merged = loadChannelsConfig(config);
    const preset = merged.presets.find((item) => item.id === "hunyuan");
    assert.ok(preset, "缺少 hunyuan 渠道模板");
    assert.equal(preset.name, "腾讯混元");
    assert.equal(preset.vendor, "tencent");
    assert.deepEqual(preset.supported_protocols, ["openai", "anthropic", "responses"]);
    assert.equal(preset.openai_base_url, "https://tokenhub.tencentmaas.com/v1");
    assert.equal(preset.anthropic_base_url, "https://tokenhub.tencentmaas.com");
    assert.equal(preset.openai_auth, "bearer");
    assert.equal(preset.anthropic_auth, "x_api_key");
    assert.equal(preset.default_model, "hy4");
    assert.equal(preset.supports_model_list, true);
    assert.equal(preset.supports_balance_query, false);
    assert.equal(preset.supports_scrape_balance, false);
  });

  it("模型端点解析到 TokenHub 的 /v1/models", () => {
    const merged = loadChannelsConfig(config);
    assert.equal(modelsEndpointUrl(channelsConfigToJson(merged), "hunyuan"), "https://tokenhub.tencentmaas.com/v1/models");
  });

  it("旧外部配置缺少 hunyuan 时由内置模板补齐，且不改动既有渠道", () => {
    const external = {
      channels_config: {
        channels: [
          {
            id: "deepseek",
            name: "DeepSeek",
            vendor: "deepseek",
            supported_protocols: ["openai", "anthropic"],
            openai_base_url: "https://api.deepseek.com",
            anthropic_base_url: "https://api.deepseek.com/anthropic",
            openai_auth: "bearer",
            anthropic_auth: "x_api_key",
            default_model: "deepseek-v4-pro",
            supports_model_list: true,
            supports_balance_query: true,
            endpoints: { models: "https://api.deepseek.com/models" },
          },
        ],
        default_exposed_models: { deepseek: ["deepseek-v4-pro"] },
        endpoints: {},
      },
    };
    const merged = loadChannelsConfig(external, config);
    const ids = merged.presets.map((preset) => preset.id);
    assert.ok(ids.includes("hunyuan"), `升级后缺少 hunyuan：${ids.join(",")}`);
    assert.ok(ids.includes("deepseek"));
    const deepseek = merged.presets.find((preset) => preset.id === "deepseek");
    assert.equal(deepseek?.openai_base_url, "https://api.deepseek.com");
    assert.deepEqual(deepseek?.supported_protocols, ["openai", "anthropic"]);
    assert.deepEqual(merged.default_exposed_models.hunyuan, ["hy4", "hy4-flash"]);
  });

  it("model-catalog.json 登记 hy4 的官方归属与 models-cn provider", () => {
    const hy4 = catalog.models.find((model) => model.id === "hy4");
    assert.ok(hy4, "model-catalog.json 缺少 hy4");
    assert.equal(hy4.ownerChannelId, "hunyuan");
    assert.equal(hy4.modelsCnProviderId, "tencent-hunyuan");
    assert.ok(hy4.aliases.includes("tencent/hy4"));
  });

  it("config.json 的默认开放模型都属于全局白名单", () => {
    const merged = loadChannelsConfig(config);
    const whitelist = new Set(catalog.models.map((model) => model.id));
    for (const [channelId, models] of Object.entries(merged.default_exposed_models)) {
      for (const model of models as string[]) {
        assert.ok(whitelist.has(model), `${channelId} 的默认模型 ${model} 不在白名单`);
      }
    }
  });
});

it("旧 SQLite 重复升级保留 HY4 账号、地址覆盖和路由状态，并补齐独立 Flash 候选", async () => {
  const { SqliteStorage } = await import("../../storage/index.ts");
  const { initializeChannelPresets, loadRuntimeSnapshot } = await import("../../config/index.ts");
  const { loadModelCatalog } = await import("../../catalog/index.ts");
  loadModelCatalog(REPO_ROOT, REPO_ROOT);
  const storage = new SqliteStorage(":memory:");
  try {
    const defaults = loadChannelsConfig(readJson("config.json"));
    storage.saveChannelPresets(defaults.presets.filter((preset) => preset.id !== "hunyuan"));
    storage.saveChannelAccounts([{
      id: "hy4-existing", channel_id: "hunyuan", name: "Existing", api_key: "test-key",
      enabled: true, priority: 17, use_upstream_proxy: false,
      base_url_override: "https://tokenhub-intl.tencentmaas.com/v1",
      anthropic_base_url_override: "https://tokenhub-intl.tencentmaas.com",
      synced_models: ["hy4", "hy4-flash", "hy4-preview"],
      exposed_models: ["hy4", "hy4-flash", "hy4-preview"],
    }]);
    storage.saveRouteCandidates([{
      id: "hy4-disabled", virtual_model_id: "hy4", channel_id: "hunyuan",
      account_id: "hy4-existing", upstream_model: "hy4", client_protocol: "openai",
      priority: 37, enabled: false,
    }]);
    const beforeAccount = storage.listChannelAccounts();
    for (let attempt = 0; attempt < 2; attempt++) {
      initializeChannelPresets(storage, defaults);
      const runtime = loadRuntimeSnapshot(storage, defaults).snapshot();
      assert.deepEqual(storage.listChannelAccounts(), beforeAccount);
      const preset = storage.listChannelPresets().find((item) => item.id === "hunyuan");
      assert.deepEqual(preset?.supported_protocols, ["openai", "anthropic", "responses"]);
      assert.equal(preset?.anthropic_auth, "x_api_key");
      const routes = storage.listRouteCandidates();
      assert.equal(routes.length, 6);
      assert.equal(routes.find((route) => route.id === "hy4-disabled")?.enabled, false);
      assert.equal(routes.find((route) => route.id === "hy4-disabled")?.priority, 37);
      assert.equal(routes.filter((route) => route.virtual_model_id === "hy4-flash").length, 3);
      assert.ok(routes.every((route) => route.upstream_model !== "hy4-preview"));
      assert.equal((runtime.routes as unknown[]).length, 6);
    }
  } finally {
    storage.close();
  }
});
