// 内置渠道协议升级契约测试。Owner: node-storage.
//
// 回归场景：旧版本写入的 `/data/config.json` 里 qwen 只有 openai/anthropic/responses，
// 新版本在 config.json 模板里给 qwen 增加 `systemone`。仅「补齐缺失渠道」不会更新既有预设，
// 导致决策模型在升级后的实例上不可选、也不生成路由。这里验证启动迁移会把内置模板声明的
// 协议写入既有预设，同时保留账号与路由数据。
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SqliteStorage } from "../../storage/index.ts";
import {
  initializeChannelPresets,
  loadChannelsConfig,
  parseChannelsConfig,
} from "../index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function tempDir(): string {
  const base = path.join(process.cwd(), ".flowlet-test-tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "preset-protocol-"));
}

test("启动迁移把内置模板新增协议写入旧外部配置的既有预设", () => {
  const dir = tempDir();
  const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
  try {
    const builtin = JSON.parse(readFileSync(path.join(REPO_ROOT, "config.json"), "utf8")) as {
      channels_config: { channels: Array<Record<string, unknown>> };
    };
    // 旧外部配置：qwen 还是三协议，且没有新增的 hunyuan 渠道。
    const external = {
      channels_config: {
        channels: builtin.channels_config.channels
          .filter((channel) => channel.id !== "hunyuan")
          .map((channel) =>
            channel.id === "qwen"
              ? { ...channel, supported_protocols: ["openai", "anthropic", "responses"] }
              : channel,
          ),
        default_exposed_models: {},
        endpoints: {},
      },
    };

    const builtinPresets = parseChannelsConfig(builtin).presets;
    initializeChannelPresets(storage, loadChannelsConfig(external, builtin), builtinPresets);

    const presets = storage.listChannelPresets();
    const qwen = presets.find((preset) => preset.id === "qwen");
    assert.ok(qwen);
    assert.deepEqual(qwen.supported_protocols, ["openai", "anthropic", "responses", "systemone"]);
    const hunyuan = presets.find((preset) => preset.id === "hunyuan");
    assert.ok(hunyuan, "缺失的新渠道仍应被补齐");
    assert.deepEqual(hunyuan.supported_protocols, ["openai", "anthropic", "responses"]);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移不改动账号、路由与账号级地址覆盖", () => {
  const dir = tempDir();
  const storage = new SqliteStorage(path.join(dir, "flowlet.sqlite"));
  try {
    const builtin = JSON.parse(readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
    const builtinPresets = parseChannelsConfig(builtin).presets;
    const external = {
      channels_config: {
        channels: builtin.channels_config.channels
          .filter((channel: { id: string }) => channel.id !== "hunyuan")
          .map((channel: { id: string; supported_protocols?: string[] }) =>
            channel.id === "qwen"
              ? { ...channel, supported_protocols: ["openai", "anthropic", "responses"] }
              : channel,
          ),
        default_exposed_models: {},
        endpoints: {},
      },
    };
    initializeChannelPresets(storage, loadChannelsConfig(external, builtin), builtinPresets);

    storage.saveChannelAccounts([
      {
        id: "account-qwen",
        channel_id: "qwen",
        name: "Qwen 主账号",
        api_key: "sk-test",
        enabled: true,
        base_url_override: "https://token-plan.example/compatible-mode/v1",
        exposed_models: ["qwen3.8-max"],
        synced_models: ["qwen3.8-max"],
      },
    ]);
    const before = storage.listChannelAccounts();

    initializeChannelPresets(storage, loadChannelsConfig(external, builtin), builtinPresets);
    const after = storage.listChannelAccounts();
    assert.equal(after.length, before.length);
    assert.equal(after[0].base_url_override, "https://token-plan.example/compatible-mode/v1");
    assert.deepEqual(after[0].exposed_models, ["qwen3.8-max"]);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
