// Web 命令层渠道模板合并契约测试（Node Web Host）。Owner: node-web.
//
// 回归（2026-11-10 线上事故）：数据卷 `/data/config.json` 由旧版本写入，缺少当前版本新增的
// 渠道（openai-api / vibetoken）。`startHost` 用 `loadChannelsConfig` 合并了镜像内置模板，
// 代理与运行时快照都正常；但 `createWebHost` 直接用原始 `channels_config`，于是：
//   - `fetch_channel_models` 报「渠道 openai-api 缺少运行时模板」；
//   - 余额同步为 vibetoken 拼出空 Base URL（`Invalid URL`）。
// Rust 侧 Web 命令复用同一份已合并的 `ChannelsConfig`，Node 侧必须对齐。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { channelsConfigToJson, loadChannelsConfig } from "../../config/index.ts";
import { modelsEndpointUrl } from "../config-state.ts";
import { createWebHost } from "../index.ts";

const BUILTIN = {
  channels_config: {
    channels: [
      {
        id: "openai-api",
        name: "ChatGPT API",
        vendor: "openai",
        supported_protocols: ["openai", "responses"],
        openai_base_url: "https://api.openai.com/v1",
        supports_model_list: true,
        supports_balance_query: false,
        endpoints: { models: "https://api.openai.com/v1/models" },
      },
      {
        id: "vibetoken",
        name: "VibeToken",
        vendor: "vibetoken",
        supported_protocols: ["openai", "responses"],
        openai_base_url: "https://vibetoken.cn/v1",
        supports_model_list: true,
        supports_balance_query: true,
        endpoints: {
          models: "https://vibetoken.cn/v1/models",
          balance: "https://vibetoken.cn/api/v1/billing/balance",
        },
      },
    ],
    default_exposed_models: { "openai-api": ["gpt-6.1-sol"] },
    endpoints: {},
  },
};

/** 模拟旧版本数据卷配置：只有既有渠道，缺少后加的两个。 */
const EXTERNAL = {
  channels_config: {
    channels: [
      {
        id: "deepseek",
        name: "DeepSeek",
        vendor: "deepseek",
        supported_protocols: ["openai", "anthropic"],
        openai_base_url: "https://api.deepseek.com/v1",
        supports_model_list: true,
        endpoints: { models: "https://api.deepseek.com/v1/models" },
      },
    ],
    default_exposed_models: { deepseek: ["deepseek-v4.1-flash"] },
    endpoints: {},
  },
};

function workDir(): string {
  const dir = path.join(tmpdir(), `flowlet-channels-config-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("channels_config 内置模板合并（Web 命令层）", () => {
  it("merged config adds channels missing from the volume config.json", () => {
    const merged = channelsConfigToJson(loadChannelsConfig(EXTERNAL, BUILTIN));
    const ids = (merged.channels as Array<{ id: string }>).map((preset) => preset.id);
    assert.deepEqual(ids.sort(), ["deepseek", "openai-api", "vibetoken"]);
    // 既有渠道的 endpoints 覆盖保留，内置模板不会覆盖它。
    assert.equal((merged.endpoints as Record<string, { models: string }>).deepseek.models, "https://api.deepseek.com/v1/models");
    assert.equal(modelsEndpointUrl(merged, "openai-api"), "https://api.openai.com/v1/models");
    assert.equal(modelsEndpointUrl(merged, "vibetoken"), "https://vibetoken.cn/v1/models");
  });

  it("raw config.json alone cannot resolve the new channels (the failing state)", () => {
    const raw = EXTERNAL.channels_config as never;
    assert.equal(modelsEndpointUrl(raw, "openai-api"), null);
    assert.equal(modelsEndpointUrl(raw, "vibetoken"), null);
  });

  it("createWebHost uses the merged channels config handed over by startHost", () => {
    const dir = workDir();
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify(EXTERNAL));
    const staticDir = path.join(dir, "ui");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");

    const merged = channelsConfigToJson(loadChannelsConfig(EXTERNAL, BUILTIN));
    const web = createWebHost({
      storage: {
        getAppMeta: () => null,
        setAppMeta: () => {},
        listChannelModels: () => [],
      } as unknown as never,
      proxy: {
        start: async () => {},
        stop: async () => {},
        status: () => ({ running: false, bind_addr: "127.0.0.1:0", started_at: null }),
        bindConfig: () => ({ host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: "t" }),
        setBindConfig: () => {},
      },
      runtimeConfig: {
        snapshot: () => ({ channels: [], accounts: [], routes: [], rules: [], virtual_models: [] }),
        replace: () => {},
        update: () => {},
      } as never,
      bindConfig: { host: "127.0.0.1", port: 0, allow_lan: false, default_client_token: "t" },
      catalogDir: dir,
      configPath,
      channelsConfig: merged,
      adminToken: "admin-token-0123456789abcdef0123",
      clientToken: "client-token",
      staticDir,
      publicProxyUrl: "http://127.0.0.1:1",
      deviceIdentity: {
        schema_version: 1,
        device_id: "device-1",
        display_name: "test",
        platform: "linux",
        app_version: "0.0.0",
        created_at: "2026-11-10T00:00:00Z",
      },
      secrets: {
        encrypt: (plaintext: string) => `v1:${Buffer.from(plaintext, "utf8").toString("base64")}`,
        decrypt: (encoded: string) => Buffer.from(encoded.replace(/^v1:/, ""), "base64").toString("utf8"),
      },
    });
    const ids = (web.context.channelsConfig.channels as Array<{ id: string }>).map((preset) => preset.id);
    assert.deepEqual(ids.sort(), ["deepseek", "openai-api", "vibetoken"]);
    assert.equal(modelsEndpointUrl(web.context.channelsConfig, "vibetoken"), "https://vibetoken.cn/v1/models");
  });
});
