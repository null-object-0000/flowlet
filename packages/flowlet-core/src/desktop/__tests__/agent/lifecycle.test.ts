// Agent 全局配置生命周期契约测试（AGENTS.md §1）。
//
// 覆盖每种 Adapter 的 inspect → apply → reapply → 关闭可选能力 → restore，
// 并在每一步用独立解析器重新解析输出（JSONC / YAML / TOML），而不是只断言字符串包含。
// Fixtures：
// - OpenCode / Pi / DSH 的 cordis.patch.yml 与 credentials 直接复用
//   `src-tauri/tests/fixtures/**` 的真实上游初始文件；
// - Claude / Codex / Hermes / DSH settings 使用 `./fixtures/` 中与上游默认文件同形的副本。
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";

import { applyClaudeCode, inspectClaudeCode, restoreClaudeCode } from "../../../agent/adapters/claude-code.ts";
import { applyCodex, inspectCodex, restoreCodex } from "../../../agent/adapters/codex.ts";
import { applyDsh, inspectDshAt, restoreDshAt } from "../../../agent/adapters/deepseek-harness.ts";
import { applyHermes, inspectHermes, restoreHermes } from "../../../agent/adapters/hermes.ts";
import { applyOpencode, inspectOpencode, restoreOpencode } from "../../../agent/adapters/opencode.ts";
import { applyPi, inspectPi, restorePi } from "../../../agent/adapters/pi.ts";
import { readJsoncSettings } from "../../../agent/jsonc.ts";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const UPSTREAM_FIXTURES = fileURLToPath(
  new URL("../../../../../../src-tauri/tests/fixtures", import.meta.url),
);
const BASE_URL = "http://127.0.0.1:18640";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "flowlet-agent-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function copy(source: string, target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function parseJsoncFile(file: string): Record<string, unknown> {
  return readJsoncSettings(file);
}

function parseYamlFile(file: string): Record<string, unknown> {
  const value: unknown = parseYaml(readFileSync(file, "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseTomlFile(file: string): Record<string, unknown> {
  const value: unknown = parseToml(readFileSync(file, "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// ─── Claude Code ────────────────────────────────────────────────────────────

describe("Claude Code 全局配置生命周期", () => {
  it("inspect → apply → reapply → restore 保留注释与用户字段", () => {
    const root = tempRoot();
    const settingsPath = path.join(root, "settings.json");
    copy(path.join(FIXTURES, "claude-settings.json"), settingsPath);
    const expected = `${BASE_URL}/anthropic`;

    assert.equal(inspectClaudeCode(settingsPath, expected).state, "other_gateway");

    const applied = applyClaudeCode(settingsPath, expected, "flowlet-token", "glm-5.3", "glm-5.3");
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.auth_token_configured, true);
    assert.equal(applied.primary_model, "glm-5.3");
    assert.equal(applied.fast_model, "glm-5.3");
    assert.equal(applied.backup_available, true);

    const firstText = readFileSync(settingsPath, "utf8");
    assert.ok(firstText.includes("User-level Claude Code settings"));
    assert.ok(firstText.includes("unrelated user variable"));
    const parsed = parseJsoncFile(settingsPath);
    const env = parsed.env as Record<string, unknown>;
    assert.equal(env.FOO, "bar");
    assert.equal(env.ANTHROPIC_BASE_URL, expected);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "flowlet-token");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_MODEL, "glm-5.3");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3");

    // 重复 apply 幂等：文件内容不漂移，状态仍为 flowlet。
    const reapplied = applyClaudeCode(settingsPath, expected, "flowlet-token", "glm-5.3", "glm-5.3");
    assert.equal(reapplied.state, "flowlet");
    assert.equal(readFileSync(settingsPath, "utf8"), firstText);
    parseJsoncFile(settingsPath);

    const restored = restoreClaudeCode(settingsPath, expected);
    assert.equal(restored.state, "other_gateway");
    const restoredText = readFileSync(settingsPath, "utf8");
    assert.ok(restoredText.includes("User-level Claude Code settings"));
    assert.ok(restoredText.includes("unrelated user variable"));
    const restoredEnv = parseJsoncFile(settingsPath).env as Record<string, unknown>;
    assert.equal(restoredEnv.FOO, "bar");
    assert.equal(restoredEnv.ANTHROPIC_API_KEY, "sk-ant-user-key");
    assert.equal(restoredEnv.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restoredEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restoredEnv.ANTHROPIC_MODEL, undefined);
    assert.equal(existsSync(path.join(root, ".flowlet", "claude-code-global-config-backup.json")), false);
  });

  it("配置不存在时 apply 创建、restore 删除", () => {
    const root = tempRoot();
    const settingsPath = path.join(root, "settings.json");
    const expected = `${BASE_URL}/anthropic`;

    assert.equal(inspectClaudeCode(settingsPath, expected).state, "not_configured");
    assert.equal(
      applyClaudeCode(settingsPath, expected, "flowlet-token", "glm-5.3", "glm-5.3").state,
      "flowlet",
    );
    assert.equal(existsSync(settingsPath), true);
    assert.equal(restoreClaudeCode(settingsPath, expected).state, "not_configured");
    assert.equal(existsSync(settingsPath), false);
  });

  it("损坏的 JSON 报告 invalid 且不抛异常", () => {
    const root = tempRoot();
    const settingsPath = path.join(root, "settings.json");
    writeFileSync(settingsPath, "{ not json !!");
    const report = inspectClaudeCode(settingsPath, `${BASE_URL}/anthropic`);
    assert.equal(report.state, "invalid");
    assert.ok(report.error !== null && report.error.includes("解析"));
  });
});

// ─── OpenCode ───────────────────────────────────────────────────────────────

describe("OpenCode 全局配置生命周期", () => {
  it("真实上游 JSONC fixture 的 inspect → apply → reapply → restore", () => {
    const root = tempRoot();
    const settingsPath = path.join(root, "opencode.jsonc");
    const authPath = path.join(root, "auth.json");
    const pluginPath = path.join(root, "plugins", "flowlet.ts");
    copy(path.join(UPSTREAM_FIXTURES, "opencode", "opencode.jsonc"), settingsPath);
    copy(path.join(UPSTREAM_FIXTURES, "opencode", "auth.json"), authPath);
    const originalText = readFileSync(settingsPath, "utf8");
    const originalAuth = readFileSync(authPath, "utf8");
    const expected = `${BASE_URL}/v1`;

    assert.equal(inspectOpencode(settingsPath, authPath, pluginPath, expected).state, "not_configured");

    const applied = applyOpencode(
      { settingsPath, authPath, permissionPluginPath: pluginPath },
      expected,
      "flowlet-token",
      "glm-5.3",
      "glm-5.3",
    );
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.opencode_permission_bridge, true);
    assert.equal(applied.primary_model, "flowlet/glm-5.3");

    const text = readFileSync(settingsPath, "utf8");
    assert.ok(text.includes("Representative upstream user setting"), "必须保留上游注释");
    const parsed = parseJsoncFile(settingsPath);
    assert.equal(parsed.theme, "system");
    assert.equal(parsed.model, "flowlet/glm-5.3");
    const provider = (parsed.provider as Record<string, unknown>).flowlet as Record<string, unknown>;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.deepEqual(provider.options, { baseURL: expected });
    const auth = parseJsoncFile(authPath);
    assert.deepEqual((auth.flowlet as Record<string, unknown>).type, "api");
    assert.equal(existsSync(pluginPath), true);

    const reapplied = applyOpencode(
      { settingsPath, authPath, permissionPluginPath: pluginPath },
      expected,
      "flowlet-token",
      "glm-5.3",
      "glm-5.3",
    );
    assert.equal(reapplied.state, "flowlet");
    assert.equal(readFileSync(settingsPath, "utf8"), text);

    const restored = restoreOpencode(
      { settingsPath, authPath, permissionPluginPath: pluginPath },
      expected,
    );
    assert.equal(restored.state, "not_configured");
    assert.equal(readFileSync(settingsPath, "utf8"), originalText);
    // auth.json 由 Rust/Flowlet 统一 pretty 序列化，格式变化但内容必须完整还原。
    assert.deepEqual(parseJsoncFile(authPath), JSON.parse(originalAuth));
    assert.equal(existsSync(pluginPath), false);
  });

  it("已有用户配置时保留其它 provider，只新增 flowlet", () => {
    const root = tempRoot();
    const settingsPath = path.join(root, "opencode.json");
    const authPath = path.join(root, "auth.json");
    const pluginPath = path.join(root, "plugins", "flowlet.ts");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          provider: { ollama: { npm: "@ai-sdk/openai-compatible" } },
          disabled_providers: ["other"],
          enabled_providers: ["ollama"],
        },
        null,
        2,
      ),
    );
    writeFileSync(authPath, "{}\n");
    const expected = `${BASE_URL}/v1`;
    assert.equal(
      applyOpencode(
        { settingsPath, authPath, permissionPluginPath: pluginPath },
        expected,
        "token",
        "glm-5.3",
        "glm-5.3",
      ).state,
      "flowlet",
    );
    const parsed = parseJsoncFile(settingsPath);
    const providers = parsed.provider as Record<string, unknown>;
    assert.ok(providers.ollama !== undefined);
    assert.ok(providers.flowlet !== undefined);
    assert.deepEqual(parsed.disabled_providers, ["other"]);
    assert.deepEqual(parsed.enabled_providers, ["ollama", "flowlet"]);
  });
});

// ─── Pi ─────────────────────────────────────────────────────────────────────

describe("Pi 全局配置生命周期", () => {
  it("真实上游 fixture：apply（开启会话扩展）→ reapply → 关闭扩展 → restore", () => {
    const root = tempRoot();
    const paths = {
      settingsPath: path.join(root, "settings.json"),
      modelsPath: path.join(root, "models.json"),
      authPath: path.join(root, "auth.json"),
      extensionPath: path.join(root, "extensions", "flowlet.ts"),
    };
    copy(path.join(UPSTREAM_FIXTURES, "pi", "settings.json"), paths.settingsPath);
    copy(path.join(UPSTREAM_FIXTURES, "pi", "models.json"), paths.modelsPath);
    copy(path.join(UPSTREAM_FIXTURES, "pi", "auth.json"), paths.authPath);
    const originalSettings = readFileSync(paths.settingsPath, "utf8");
    const originalModels = readFileSync(paths.modelsPath, "utf8");
    const originalAuth = readFileSync(paths.authPath, "utf8");
    const expected = `${BASE_URL}/v1`;

    assert.equal(inspectPi(paths, expected).state, "not_configured");

    const applied = applyPi(paths, expected, "flowlet-token", true, "glm-5.3", "glm-5.3");
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.session_extension, true);
    assert.ok(readFileSync(paths.extensionPath, "utf8").includes("x-flowlet-session"));

    const models = parseJsoncFile(paths.modelsPath);
    const providers = models.providers as Record<string, unknown>;
    assert.ok(providers.ollama !== undefined, "用户已有 provider 必须保留");
    const flowlet = providers.flowlet as Record<string, unknown>;
    assert.equal(flowlet.baseUrl, expected);
    assert.equal(flowlet.api, "openai-completions");
    assert.deepEqual(flowlet.headers, { "x-flowlet-client": "pi" });
    assert.deepEqual(flowlet.models, [{ id: "glm-5.3", name: "glm-5.3" }]);
    const settings = parseJsoncFile(paths.settingsPath);
    assert.equal(settings.defaultProvider, "flowlet");
    assert.equal(settings.defaultModel, "glm-5.3");

    const reapplied = applyPi(paths, expected, "flowlet-token", true, "glm-5.3", "glm-5.3");
    assert.equal(reapplied.state, "flowlet");

    // 关闭可选能力：扩展文件移除，基础 Provider 接入保持 flowlet。
    const disabled = applyPi(paths, expected, "flowlet-token", false, "glm-5.3", "glm-5.3");
    assert.equal(disabled.state, "flowlet");
    assert.equal(disabled.session_extension, false);
    assert.equal(existsSync(paths.extensionPath), false);

    const restored = restorePi(paths, expected);
    assert.equal(restored.state, "not_configured");
    assert.equal(readFileSync(paths.settingsPath, "utf8"), originalSettings);
    assert.equal(readFileSync(paths.modelsPath, "utf8"), originalModels);
    assert.deepEqual(parseJsoncFile(paths.authPath), JSON.parse(originalAuth));
    assert.equal(existsSync(paths.extensionPath), false);
  });
});

// ─── Codex ──────────────────────────────────────────────────────────────────

describe("Codex 全局配置生命周期", () => {
  it("inspect → apply（动态模型目录）→ reapply → restore 保留注释与其它表", () => {
    const root = tempRoot();
    const paths = {
      configPath: path.join(root, "config.toml"),
      authPath: path.join(root, "auth.json"),
      modelsPath: path.join(root, "model-catalog.flowlet.json"),
    };
    copy(path.join(FIXTURES, "codex-config.toml"), paths.configPath);
    copy(path.join(FIXTURES, "codex-auth.json"), paths.authPath);
    const originalConfig = readFileSync(paths.configPath, "utf8");
    const originalAuth = readFileSync(paths.authPath, "utf8");
    const expected = `${BASE_URL}/v1`;

    assert.equal(inspectCodex(paths, expected).state, "other_gateway");

    const applied = applyCodex(paths, expected, "flowlet-token", "glm-5.3", null);
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.primary_model, "glm-5.3");
    assert.equal(applied.model_catalog_path, "~/.codex/model-catalog.flowlet.json");
    assert.equal(applied.model_catalog_configured, true);

    const configText = readFileSync(paths.configPath, "utf8");
    assert.ok(configText.includes("# Codex user config. Keep this comment after Flowlet writes."));
    assert.ok(configText.includes("user-selected model"));
    assert.ok(configText.includes("[profiles.fast]"), "其它表必须保留");
    const config = parseTomlFile(paths.configPath);
    assert.equal(config.model, "glm-5.3");
    assert.equal(config.model_provider, "flowlet");
    assert.equal(config.disable_response_storage, true);
    assert.equal(config.preferred_auth_method, "apikey");
    assert.equal(config.model_catalog_json, "~/.codex/model-catalog.flowlet.json");
    const providers = config.model_providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.openai.base_url, "https://api.openai.com/v1");
    assert.deepEqual({ ...providers.flowlet }, {
      name: "flowlet",
      base_url: expected,
      wire_api: "responses",
      requires_openai_auth: true,
    });
    const auth = parseJsoncFile(paths.authPath) as Record<string, unknown>;
    assert.equal(auth.OPENAI_API_KEY, "flowlet-token");
    assert.ok(auth.tokens !== undefined, "原有登录态字段必须保留");
    const catalog = JSON.parse(readFileSync(paths.modelsPath, "utf8")) as Record<string, unknown>;
    const entry = (catalog.models as Array<Record<string, unknown>>)[0];
    assert.equal(entry.slug, "glm-5.3");
    assert.equal(entry.context_window, 128000);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.deepEqual(entry.supported_reasoning_levels instanceof Array, true);
    assert.equal(entry.default_reasoning_level, "medium");

    const reapplied = applyCodex(paths, expected, "flowlet-token", "glm-5.3", null);
    assert.equal(reapplied.state, "flowlet");
    assert.equal(readFileSync(paths.configPath, "utf8"), configText);
    parseTomlFile(paths.configPath);

    const restored = restoreCodex(paths, expected);
    assert.equal(restored.state, "other_gateway");
    assert.equal(readFileSync(paths.configPath, "utf8"), originalConfig);
    assert.deepEqual(parseJsoncFile(paths.authPath), JSON.parse(originalAuth));
    assert.equal(existsSync(paths.modelsPath), false);
  });

  it("模型目录按 models-cn 规格生成上下文窗口与推理档位", () => {
    const root = tempRoot();
    const paths = {
      configPath: path.join(root, "config.toml"),
      authPath: path.join(root, "auth.json"),
      modelsPath: path.join(root, "model-catalog.flowlet.json"),
    };
    const modelsCn = {
      providers: [
        {
          id: "zhipu",
          models: [
            {
              id: "glm-5.3",
              name: "GLM-5.3",
              capabilities: { thinking: true, inputModalities: ["text", "image", "video"] },
              limits: { contextTokens: 1000000 },
            },
          ],
        },
      ],
    };
    const modelCatalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../../../../model-catalog.json", import.meta.url)), "utf8"),
    ) as { models: Array<Record<string, unknown>> };
    const glm = modelCatalog.models.find((model) => model.id === "glm-5.3");
    assert.ok(glm !== undefined, "model-catalog.json 必须登记 glm-5.3");
    const providers = modelsCn.providers as Array<Record<string, unknown>>;
    providers[0].id = String(glm.modelsCnProviderId);

    applyCodex(paths, `${BASE_URL}/v1`, "token", "glm-5.3", modelsCn);
    const catalog = JSON.parse(readFileSync(paths.modelsPath, "utf8")) as Record<string, unknown>;
    const entry = (catalog.models as Array<Record<string, unknown>>)[0];
    assert.equal(entry.context_window, 1000000);
    assert.equal(entry.max_context_window, 1000000);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    const efforts = entry.supported_reasoning_levels as Array<Record<string, unknown>>;
    assert.deepEqual(
      efforts.map((effort) => effort.effort),
      ["low", "medium", "high", "xhigh"],
    );
    assert.equal(entry.default_reasoning_level, "high");
    assert.equal(entry.supports_reasoning_summaries, true);
  });

  it("写入失败回滚且不破坏原文件", () => {
    const root = tempRoot();
    const paths = {
      configPath: path.join(root, "config.toml"),
      authPath: path.join(root, "auth.json"),
      modelsPath: path.join(root, "model-catalog.flowlet.json"),
    };
    copy(path.join(FIXTURES, "codex-config.toml"), paths.configPath);
    // 让 auth.json 成为目录，写入必然失败；事务应回滚已写入的 config.toml。
    mkdirSync(paths.authPath);
    const original = readFileSync(paths.configPath, "utf8");
    assert.throws(
      () => applyCodex(paths, `${BASE_URL}/v1`, "token", "glm-5.3", null),
      /已回滚/u,
    );
    assert.equal(readFileSync(paths.configPath, "utf8"), original);
    assert.equal(existsSync(paths.modelsPath), false);
    assert.equal(existsSync(path.join(root, ".flowlet", "codex-global-config-backup.json")), false);
  });
});

// ─── DeepSeek Harness ───────────────────────────────────────────────────────

describe("DeepSeek Harness 全局配置生命周期", () => {
  function setupDsh(): { home: string; profilePatch: string; settingsPath: string } {
    const home = tempRoot();
    const profile = path.join(home, "profiles", "web");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      path.join(profile, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 2),
    );
    const profilePatch = path.join(profile, "cordis.patch.yml");
    copy(path.join(UPSTREAM_FIXTURES, "deepseek-harness", "web", "cordis.patch.yml"), profilePatch);
    copy(
      path.join(UPSTREAM_FIXTURES, "deepseek-harness", "credentials.v1.yaml"),
      path.join(home, ".credentials.yaml"),
    );
    const settingsPath = path.join(home, "settings.yaml");
    copy(path.join(FIXTURES, "dsh-settings.yaml"), settingsPath);
    return { home, profilePatch, settingsPath };
  }

  it("apply（会话桥 + MCP）→ reapply → 关闭可选能力 → restore", () => {
    const { home, profilePatch, settingsPath } = setupDsh();
    const credentialsPath = path.join(home, ".credentials.yaml");
    const expected = `${BASE_URL}/v1`;
    const originalPatch = readFileSync(profilePatch, "utf8");
    const originalCredentials = readFileSync(credentialsPath, "utf8");
    const originalSettings = readFileSync(settingsPath, "utf8");

    assert.equal(inspectDshAt(home, expected).state, "not_configured");

    const servers = [
      {
        id: "chrome",
        serverName: "chrome",
        transport: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp"],
        env: { TOKEN: "value with space" },
      },
    ];
    const applied = applyDsh({
      home,
      expectedBaseUrl: expected,
      clientToken: "flowlet-token",
      sessionExtension: true,
      primaryModel: "glm-5.3",
      mcpServers: servers,
    });
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.session_extension, true);
    assert.equal(applied.mcp_servers.length, 1);
    assert.equal(applied.mcp_servers[0].serverName, "chrome");

    const settings = parseYamlFile(settingsPath);
    assert.ok(readFileSync(settingsPath, "utf8").includes("# DeepSeek Harness user settings"));
    assert.equal(
      (settings["agent-default-model"] as Record<string, unknown>).provider,
      "flowlet",
    );
    const settingsProvider = (
      (settings["llm-pi-ai"] as Record<string, unknown>).providers as Record<string, unknown>
    ).flowlet as Record<string, unknown>;
    assert.equal(settingsProvider.baseURL, expected);
    assert.equal(settingsProvider.apiKeyEnv, "FLOWLET_CLIENT_TOKEN");
    assert.deepEqual(settingsProvider.models, [{ id: "glm-5.3" }]);

    const credentials = parseYamlFile(credentialsPath);
    assert.equal((credentials.refs as Record<string, unknown>).FLOWLET_CLIENT_TOKEN, "flowlet-token");
    assert.equal((credentials.refs as Record<string, unknown>).EXISTING_TOKEN, "keep-me");

    const patchText = readFileSync(profilePatch, "utf8");
    parseYaml(patchText);
    assert.ok(patchText.includes("flowlet-managed:start deepseek-harness-session-bridge"));
    assert.ok(patchText.includes("flowlet-managed:start deepseek-harness-mcp-servers"));
    assert.ok(readFileSync(path.join(home, "profiles", "web", ".flowlet", "flowlet-session-bridge.mjs"), "utf8").includes("AsyncLocalStorage"));

    // 重复 apply 幂等（受管块不叠加、MCP 块整体重写）。
    const reapplied = applyDsh({
      home,
      expectedBaseUrl: expected,
      clientToken: "flowlet-token",
      sessionExtension: true,
      primaryModel: "glm-5.3",
      mcpServers: servers,
    });
    assert.equal(reapplied.state, "flowlet");
    const reappliedPatch = readFileSync(profilePatch, "utf8");
    assert.equal(reappliedPatch.match(/flowlet-managed:start deepseek-harness-mcp-servers/gu)?.length, 1);

    // 关闭可选能力：会话桥与 MCP 受管块都移除，基础接入保持 flowlet。
    const disabled = applyDsh({
      home,
      expectedBaseUrl: expected,
      clientToken: "flowlet-token",
      sessionExtension: false,
      primaryModel: "glm-5.3",
      mcpServers: [],
    });
    assert.equal(disabled.state, "flowlet");
    assert.equal(disabled.session_extension, false);
    assert.deepEqual(disabled.mcp_servers, []);
    parseYaml(readFileSync(profilePatch, "utf8"));

    const restored = restoreDshAt(home, expected);
    assert.equal(restored.state, "not_configured");
    assert.equal(readFileSync(profilePatch, "utf8"), originalPatch);
    assert.equal(readFileSync(credentialsPath, "utf8"), originalCredentials);
    const restoredSettings = parseYamlFile(settingsPath);
    assert.deepEqual(restoredSettings, parseYaml(originalSettings) as Record<string, unknown>);
    assert.ok(readFileSync(settingsPath, "utf8").includes("# DeepSeek Harness user settings"));
  });

  it("没有 Profile 时开启会话扩展给出明确错误", () => {
    const home = tempRoot();
    copy(path.join(FIXTURES, "dsh-settings.yaml"), path.join(home, "settings.yaml"));
    assert.throws(
      () =>
        applyDsh({
          home,
          expectedBaseUrl: `${BASE_URL}/v1`,
          clientToken: "token",
          sessionExtension: true,
          primaryModel: "glm-5.3",
          mcpServers: null,
        }),
      /尚未发现可安装 Flowlet 会话插件的 DSH Profile/u,
    );
  });
});

// ─── Hermes Agent ───────────────────────────────────────────────────────────

describe("Hermes Agent 全局配置生命周期", () => {
  it("apply（开启会话桥）→ reapply → 关闭 → restore 保留注释与 .env", () => {
    const root = tempRoot();
    const paths = {
      configPath: path.join(root, "config.yaml"),
      envPath: path.join(root, ".env"),
    };
    copy(path.join(FIXTURES, "hermes-config.yaml"), paths.configPath);
    copy(path.join(FIXTURES, "hermes.env"), paths.envPath);
    const originalConfig = readFileSync(paths.configPath, "utf8");
    const originalEnv = readFileSync(paths.envPath, "utf8");
    const expected = `${BASE_URL}/v1`;
    const envKey = "HERMES_CUSTOM_127_0_0_1_18640_API_KEY";

    assert.equal(inspectHermes(paths, expected).state, "not_configured");

    const applied = applyHermes(paths, expected, "flowlet-token", "glm-5.3", true);
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.session_extension, true);
    assert.equal(applied.primary_model, "glm-5.3");
    assert.ok(readFileSync(paths.configPath, "utf8").includes("# Hermes Agent user config."));

    const config = parseYamlFile(paths.configPath);
    const model = config.model as Record<string, unknown>;
    assert.equal(model.provider, "custom");
    assert.equal(model.default, "glm-5.3");
    assert.equal(model.base_url, expected);
    assert.equal(model.api_key, `\${${envKey}}`);
    assert.deepEqual(model.default_headers, { "x-flowlet-client": "hermes" });
    const plugins = config.plugins as Record<string, unknown>;
    assert.deepEqual(plugins.enabled, ["flowlet-session-bridge"]);
    assert.equal(readFileSync(paths.envPath, "utf8").includes("OTHER_KEY=keep-me"), true);
    assert.equal(readFileSync(paths.envPath, "utf8").includes(`${envKey}=flowlet-token`), true);
    assert.equal(
      existsSync(path.join(root, "plugins", "flowlet-session-bridge", "plugin.yaml")),
      true,
    );

    const reapplied = applyHermes(paths, expected, "flowlet-token", "glm-5.3", true);
    assert.equal(reapplied.state, "flowlet");

    const disabled = applyHermes(paths, expected, "flowlet-token", "glm-5.3", false);
    assert.equal(disabled.state, "flowlet");
    assert.equal(disabled.session_extension, false);
    assert.equal(
      existsSync(path.join(root, "plugins", "flowlet-session-bridge", "plugin.yaml")),
      false,
    );
    assert.deepEqual((parseYamlFile(paths.configPath).plugins as Record<string, unknown>).enabled, []);

    const restored = restoreHermes(paths, expected);
    assert.equal(restored.state, "not_configured");
    assert.deepEqual(parseYamlFile(paths.configPath), parseYaml(originalConfig) as Record<string, unknown>);
    assert.ok(readFileSync(paths.configPath, "utf8").includes("# Hermes Agent user config."));
    const restoredEnv = readFileSync(paths.envPath, "utf8");
    assert.ok(restoredEnv.includes("OTHER_KEY=keep-me"));
    assert.ok(!restoredEnv.includes("FLOWLET") && !restoredEnv.includes("HERMES_CUSTOM"));
  });
});