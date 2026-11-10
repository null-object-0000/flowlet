// Agent 接入 17 条桌面命令的注册表与命令级契约测试。
//
// 覆盖：
// - 17 条命令全部注册，且 `list_agent_capabilities` 输出与 plugin-registry.json 一致（camelCase）；
// - inspect → apply（显式模型/默认模型）→ 重复 apply → restore 经由命令层走通，Home 指向临时目录；
// - 未选择模型时按可用模型字典序补齐、非法模型写文件前拒绝；
// - detect_agent_environment 对未知 Agent 报 Rust 对齐错误；
// - start/stop_agent_runtime 走 host channel 并拒绝接管外部进程；
// - check_agent_latest_versions 缓存与单 Agent 失败隔离；
// - Codex 缓存/删除/同步（后台任务写库）与 Antigravity 删除；
// - MCP 服务器参数校验与受管块写入。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hasDesktopCommand, desktopCommandNames, dispatchDesktop } from "../../commands.ts";
import { handlers } from "../../agent.ts";
import { setHomeDirForTests } from "../../../agent/paths.ts";
import {
  setDshDetectForTests,
  setRuntimeHealthAddressForTests,
} from "../../../agent/environment.ts";
import {
  clearVersionCache,
  setVersionFetchForTests,
} from "../../../agent/version.ts";
import type { JsonRow } from "../../../types.ts";
import { CommandError } from "../../../types.ts";
import { RuntimeConfig } from "../../../config/index.ts";
import { createTestContext, samplePreset, type TestContext } from "../support.ts";

const COMMANDS = [
  "detect_agent_environment",
  "start_agent_runtime",
  "stop_agent_runtime",
  "check_agent_latest_versions",
  "list_cached_codex_accounts",
  "query_codex_account",
  "query_codex_accounts",
  "query_antigravity_accounts",
  "authorize_antigravity_account",
  "delete_antigravity_account",
  "sync_codex_accounts",
  "authorize_codex_account",
  "delete_codex_account",
  "inspect_agent_global_config",
  "apply_agent_global_config",
  "restore_agent_global_config",
  "list_agent_capabilities",
];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);

let context: TestContext;
let home: string;

beforeEach(() => {
  context = createTestContext({ prefix: "flowlet-agent-cmd-" });
  home = mkdtempSync(path.join(tmpdir(), "flowlet-agent-home-"));
  setHomeDirForTests(home);
  setRuntimeHealthAddressForTests("127.0.0.1:1");
});

afterEach(() => {
  setHomeDirForTests(null);
  setRuntimeHealthAddressForTests(null);
  setDshDetectForTests(null);
  setVersionFetchForTests(null);
  clearVersionCache();
  context.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function dispatch(command: string, args: JsonRow = {}): Promise<JsonRow> {
  return (await dispatchDesktop(context.ctx, command, args)) as JsonRow;
}

function writeSettings(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** 注入一条 responses 协议可用路由（Codex 一键接入的模型来源）。 */
function useResponsesRoute(): void {
  const preset = {
    ...samplePreset("openai-api"),
    supported_protocols: ["openai", "anthropic", "responses"],
  };
  const runtime = new RuntimeConfig({
    channels: [preset],
    accounts: [
      {
        id: "acc-1",
        channel_id: "openai-api",
        name: "main",
        api_key: "sk-test",
        enabled: true,
        priority: 1,
        credential_status: "healthy",
      },
    ],
    routes: [
      {
        id: "route-1",
        virtual_model_id: "glm-5.3",
        channel_id: "openai-api",
        account_id: "acc-1",
        upstream_model: "glm-5.3",
        client_protocol: "responses",
        priority: 1,
        enabled: true,
      },
      {
        id: "route-2",
        virtual_model_id: "LongCat-2.5",
        channel_id: "openai-api",
        account_id: "acc-1",
        upstream_model: "LongCat-2.5",
        client_protocol: "responses",
        priority: 2,
        enabled: true,
      },
    ],
    rules: [],
    virtual_models: [],
  });
  // 命令层只读 runtimeConfig.snapshot()，用 replace 注入快照。
  context.ctx.runtimeConfig = runtime;
}

describe("Agent 接入命令注册表", () => {
  it("17 条命令全部注册且暴露的 handler 数量一致", () => {
    assert.equal(Object.keys(handlers).length, 17);
    for (const command of COMMANDS) {
      assert.ok(hasDesktopCommand(command), `缺少桌面命令 ${command}`);
      assert.equal(typeof handlers[command], "function");
    }
    assert.ok(desktopCommandNames().includes("apply_agent_global_config"));
  });

  it("list_agent_capabilities 与 plugin-registry.json 声明一致（camelCase）", () => {
    const report = handlers.list_agent_capabilities as () => JsonRow;
    const value = report() as { agents: JsonRow[] };
    const registry = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "plugin-registry.json"), "utf8"),
    ) as { plugins: JsonRow[] };
    const declared = registry.plugins
      .filter((plugin) => plugin.kind === "agent")
      .map((plugin) => plugin.agent as JsonRow);
    assert.deepEqual(
      value.agents.map((agent) => agent.id),
      declared.map((agent) => agent.id),
    );
    for (const agent of value.agents) {
      const descriptor = declared.find((item) => item.id === agent.id);
      assert.ok(descriptor !== undefined);
      assert.equal(agent.name, descriptor.name);
      assert.deepEqual(agent.surfaces, descriptor.surfaces);
      const expectedSessions = (descriptor.sessionTypes as JsonRow[]).map((session) => ({
        id: session.id,
        name: session.name,
        clientId: session.clientId,
      }));
      assert.deepEqual(agent.sessionTypes, expectedSessions);
      const expectedCapabilities = (descriptor.configCapabilities as JsonRow[]).map((capability) => ({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        defaultEnabled: capability.defaultEnabled,
        requiresRestart: capability.requiresRestart,
      }));
      assert.deepEqual(agent.configCapabilities, expectedCapabilities);
    }
  });
});

describe("detect_agent_environment", () => {
  it("未知 Agent 返回 Rust 对齐错误，不伪造安装报告", async () => {
    await assert.rejects(
      () => dispatch("detect_agent_environment", { agentId: "missing" }),
      (error: unknown) =>
        error instanceof Error && error.message === "暂不支持检测 Agent：missing",
    );
  });

  it("缺少 agentId 参数时报参数错误", async () => {
    await assert.rejects(
      () => dispatch("detect_agent_environment", {}),
      (error: unknown) =>
        error instanceof CommandError &&
        error.status === 400 &&
        error.message === "参数 agentId: invalid type: null, expected a string",
    );
  });

  it("已知 Agent 返回 snake_case 报告结构", async () => {
    const report = await dispatch("detect_agent_environment", { agentId: "claude-code" });
    assert.equal(report.agent_id, "claude-code");
    assert.equal(report.agent_name, "Claude Code");
    assert.equal(typeof report.installed, "boolean");
    assert.ok(Array.isArray(report.installations));
    assert.equal("runtime_running" in report && report.runtime_running !== undefined, false);
  });
});

describe("Agent 全局配置命令", () => {
  it("inspect → apply → 重复 apply → restore（Codex，显式模型）", async () => {
    useResponsesRoute();
    const codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, "config.toml"),
      '# user config\nmodel = "gpt-5"\nmodel_provider = "openai"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n',
    );
    writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"user-key"}\n');

    const inspected = await dispatch("inspect_agent_global_config", { agentId: "codex" });
    assert.equal(inspected.agent_id, "codex");
    assert.equal(inspected.state, "partial");
    assert.equal(inspected.primary_model, "gpt-5");
    assert.equal(inspected.settings_exists, true);

    const applied = await dispatch("apply_agent_global_config", {
      agentId: "codex",
      options: { primaryModel: "glm-5.3" },
    });
    assert.equal(applied.state, "flowlet");
    assert.equal(applied.primary_model, "glm-5.3");
    assert.equal(applied.model_catalog_path, "~/.codex/model-catalog.flowlet.json");
    assert.equal(applied.model_catalog_configured, true);
    const appliedConfig = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.ok(appliedConfig.includes("# user config"));
    assert.ok(appliedConfig.includes("[profiles.fast]"));

    const reapplied = await dispatch("apply_agent_global_config", {
      agentId: "codex",
      options: { primaryModel: "glm-5.3" },
    });
    assert.equal(reapplied.state, "flowlet");
    assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), appliedConfig);

    const restored = await dispatch("restore_agent_global_config", { agentId: "codex" });
    assert.equal(restored.state, "partial");
    assert.ok(readFileSync(path.join(codexHome, "config.toml"), "utf8").includes('model = "gpt-5"'));
    assert.equal(existsSync(path.join(codexHome, "model-catalog.flowlet.json")), false);
  });

  it("未选模型时按当前协议可用模型字典序补齐", async () => {
    useResponsesRoute();
    const applied = await dispatch("apply_agent_global_config", { agentId: "codex" });
    assert.equal(applied.state, "flowlet");
    // "LongCat-2.5" < "glm-5.3"（ASCII 大写字母在小写之前）。
    assert.equal(applied.primary_model, "LongCat-2.5");
  });

  it("没有可用模型时拒绝写入并保持原文件不变", async () => {
    const codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const original = '# keep\nmodel = "gpt-5"\n';
    writeFileSync(path.join(codexHome, "config.toml"), original);
    await assert.rejects(
      () => dispatch("apply_agent_global_config", { agentId: "codex" }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("没有可用的开放模型"),
    );
    assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), original);
  });

  it("非法模型在写文件之前被拒绝", async () => {
    useResponsesRoute();
    const codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const original = '# keep\nmodel = "gpt-5"\n';
    writeFileSync(path.join(codexHome, "config.toml"), original);
    await assert.rejects(
      () =>
        dispatch("apply_agent_global_config", {
          agentId: "codex",
          options: { primaryModel: "flowlet-pro" },
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("不在 Flowlet 模型目录中"),
    );
    assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), original);
    assert.equal(existsSync(path.join(codexHome, "model-catalog.flowlet.json")), false);
  });

  it("未注册 Agent 报 Rust 对齐错误", async () => {
    await assert.rejects(
      () => dispatch("inspect_agent_global_config", { agentId: "missing" }),
      (error: unknown) =>
        error instanceof Error && error.message === "未注册的 Agent 插件：missing",
    );
  });

  it("Pi 会话扩展开关：开启部署扩展、关闭移除", async () => {
    useResponsesRoute();
    const piDir = path.join(home, ".pi", "agent");
    writeSettings(path.join(piDir, "models.json"), { providers: {} });
    writeSettings(path.join(piDir, "settings.json"), {});
    writeSettings(path.join(piDir, "auth.json"), {});

    const enabled = await dispatch("apply_agent_global_config", {
      agentId: "pi",
      options: { primaryModel: "glm-5.3", sessionExtension: true },
    });
    assert.equal(enabled.state, "flowlet");
    assert.equal(enabled.session_extension, true);
    assert.equal(existsSync(path.join(piDir, "extensions", "flowlet.ts")), true);

    const disabled = await dispatch("apply_agent_global_config", {
      agentId: "pi",
      options: { primaryModel: "glm-5.3", sessionExtension: false },
    });
    assert.equal(disabled.state, "flowlet");
    assert.equal(disabled.session_extension, false);
    assert.equal(existsSync(path.join(piDir, "extensions", "flowlet.ts")), false);
  });

  it("DeepSeek Harness MCP 参数校验在写文件前拒绝非法 serverName", async () => {
    useResponsesRoute();
    const dshHome = path.join(home, ".dsh");
    mkdirSync(dshHome, { recursive: true });
    writeFileSync(path.join(dshHome, "settings.yaml"), "ui:\n  theme: dark\n");
    await assert.rejects(
      () =>
        dispatch("apply_agent_global_config", {
          agentId: "deepseek-harness",
          options: {
            primaryModel: "glm-5.3",
            mcpServers: [
              { id: "bad", serverName: "has space", transport: "stdio", command: "npx" },
            ],
          },
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("MCP serverName 必须是"),
    );
    assert.equal(readFileSync(path.join(dshHome, "settings.yaml"), "utf8"), "ui:\n  theme: dark\n");
    const inspected = await dispatch("inspect_agent_global_config", {
      agentId: "deepseek-harness",
    });
    assert.equal(inspected.state, "not_configured");
  });

  it("options 字段类型错误按 serde 文案报错", async () => {
    await assert.rejects(
      () =>
        dispatch("apply_agent_global_config", {
          agentId: "codex",
          options: { sessionExtension: "yes" },
        }),
      (error: unknown) =>
        error instanceof CommandError &&
        error.message.includes("field `sessionExtension`: invalid type: string \"yes\", expected a boolean"),
    );
  });
});

describe("Agent 运行时命令", () => {
  const dshReport = {
    agent_id: "deepseek-harness",
    agent_name: "DeepSeek Harness",
    installed: true,
    runtime_running: false,
    primary: {
      surface: "web" as const,
      executable_path: "/tmp/dsh",
      install_dir: "/tmp",
      install_method: "npm" as const,
      version: "0.1.1",
      version_output: "0.1.1",
      available_on_path: true,
      error: null,
    },
    installations: [],
  };

  it("start 通过 host channel 启动并返回运行态报告", async () => {
    context.host.respond("agentRuntime.status", () => ({ running: false, external: false }));
    context.host.respond("agentRuntime.start", () => ({ running: true, pid: 1234 }));
    let detected = 0;
    setDshDetectForTests(() => {
      detected += 1;
      return {
        ...dshReport,
        runtime_running: detected > 1,
        installations: detected > 1 ? dshReport.installations : [],
      };
    });
    const report = await dispatch("start_agent_runtime", { agentId: "deepseek-harness" });
    assert.equal(report.runtime_running, true);
    assert.equal(report.runtime_command, "dsh web --no-open");
    assert.ok(context.host.calls.some((call) => call.channel === "agentRuntime.start"));
    assert.deepEqual(
      context.host.calls.find((call) => call.channel === "agentRuntime.start")?.payload,
      { agentType: "deepseek-harness" },
    );
  });

  it("start 在 host 未能启动时报错，不伪造 running", async () => {
    context.host.respond("agentRuntime.status", () => ({ running: false, external: false }));
    context.host.respond("agentRuntime.start", () => ({ running: false }));
    setDshDetectForTests(() => dshReport);
    await assert.rejects(
      () => dispatch("start_agent_runtime", { agentId: "deepseek-harness" }),
      (error: unknown) => error instanceof Error && error.message.includes("未就绪"),
    );
  });

  it("运行中且非托管时拒绝接管", async () => {
    context.host.respond("agentRuntime.status", () => ({ running: true, external: true }));
    setDshDetectForTests(() => ({ ...dshReport, runtime_running: true }));
    const report = await dispatch("detect_agent_environment", { agentId: "deepseek-harness" });
    assert.equal(report.runtime_managed, false);
    await assert.rejects(
      () => dispatch("start_agent_runtime", { agentId: "deepseek-harness" }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("已由 Flowlet 之外的进程启动"),
    );
  });

  it("stop 在非托管运行态时拒绝终止未知进程", async () => {
    context.host.respond("agentRuntime.status", () => ({ running: true, external: true }));
    setDshDetectForTests(() => ({ ...dshReport, runtime_running: true }));
    await assert.rejects(
      () => dispatch("stop_agent_runtime", { agentId: "deepseek-harness" }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("不是由当前 Flowlet 启动"),
    );
  });

  it("stop 在未运行时返回报告且不调用 channel", async () => {
    context.host.respond("agentRuntime.status", () => ({ running: false, external: false }));
    setDshDetectForTests(() => dshReport);
    const report = await dispatch("stop_agent_runtime", { agentId: "deepseek-harness" });
    assert.equal(report.agent_id, "deepseek-harness");
    assert.equal(report.runtime_managed, false);
    assert.equal(
      context.host.calls.some((call) => call.channel === "agentRuntime.stop"),
      false,
    );
  });
});

describe("check_agent_latest_versions", () => {
  it("成功返回版本，单 Agent 失败独立报告，第二次读取命中缓存", async () => {
    let requests = 0;
    setVersionFetchForTests(async (url) => {
      requests += 1;
      if (url.includes("@openai/codex")) {
        return { status: 500, value: null, text: "" };
      }
      return { status: 200, value: { version: "9.9.9" }, text: '{"version":"9.9.9"}' };
    });
    const report = await dispatch("check_agent_latest_versions");
    const agents = report.agents as JsonRow[];
    assert.equal(agents.length, 6);
    const codex = agents.find((agent) => agent.agent_id === "codex");
    assert.ok(codex !== undefined);
    assert.equal(codex.latest_version, null);
    assert.equal(codex.error, "版本源返回 HTTP 500");
    const claude = agents.find((agent) => agent.agent_id === "claude-code");
    assert.equal(claude?.latest_version, "9.9.9");
    assert.equal(typeof claude?.checked_at, "number");
    const before = requests;
    await dispatch("check_agent_latest_versions");
    assert.equal(requests, before, "15 分钟内应命中进程内缓存");
  });
});

describe("Codex 账号命令", () => {
  it("缓存读取只返回 signed_in 快照，删除只移除托管目录", async () => {
    const managed = path.join(context.dir, "codex-accounts", "acc-1");
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      path.join(managed, "snapshot.json"),
      JSON.stringify({
        account_id: "acc-1",
        signed_in: true,
        email: "user@example.test",
        source: "oauth",
        updated_at: "2026-01-01T00:00:00Z",
        stale: false,
      }),
    );
    writeFileSync(path.join(managed, "auth.json"), "{}");
    writeFileSync(path.join(managed, "config.toml"), 'cli_auth_credentials_store = "file"\n');

    const cached = await dispatch("list_cached_codex_accounts");
    const accounts = cached.accounts as JsonRow[];
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].account_id, "acc-1");
    assert.equal(accounts[0].email, "user@example.test");

    const deleted = await dispatch("delete_codex_account", { accountId: "acc-1" });
    assert.equal(deleted.accountId, "acc-1");
    assert.equal(deleted.email, "user@example.test");
    assert.equal(existsSync(managed), false);

    await assert.rejects(
      () => dispatch("delete_codex_account", { accountId: "missing" }),
      (error: unknown) =>
        error instanceof Error && error.message === "未找到 Codex 账号 missing 的托管配置",
    );
  });

  it("sync_codex_accounts 无账号来源时跳过且不写后台任务", async () => {
    const result = await dispatch("sync_codex_accounts", { triggerSource: "manual" });
    assert.equal(result.started, false);
    assert.equal(result.message, "未发现 Codex 账号，已跳过本次同步");
    assert.equal(result.accounts, 0);
  });

  it("sync_codex_accounts 有账号时写 background_jobs 记录", async () => {
    const managed = path.join(context.dir, "codex-accounts", "acc-2");
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, "auth.json"), "{}");
    writeFileSync(
      path.join(managed, "snapshot.json"),
      JSON.stringify({
        account_id: "acc-2",
        signed_in: true,
        email: "stale@example.test",
        source: "oauth",
        updated_at: "2026-01-01T00:00:00Z",
        stale: false,
      }),
    );
    const result = await dispatch("sync_codex_accounts", { triggerSource: "manual" });
    assert.equal(result.started, true);
    assert.equal(typeof result.jobId, "string");
    const rows = context.storage.withDatabase((db) =>
      db.prepare("SELECT status, job_type FROM background_jobs WHERE id=?").get(String(result.jobId)),
    ) as JsonRow;
    assert.equal(rows.job_type, "codex-account-sync");
    assert.ok(["succeeded", "succeeded_with_warnings"].includes(String(rows.status)));
  });
});

describe("Antigravity 账号命令", () => {
  it("query_antigravity_accounts 无授权目录且无本机服务时返回空列表", async () => {
    const report = await dispatch("query_antigravity_accounts");
    assert.deepEqual(report, { accounts: [] });
  });

  it("delete_antigravity_account 移除托管凭据文件（不存在也算成功）", async () => {
    const root = path.join(context.dir, "antigravity-accounts");
    const result = await dispatch("delete_antigravity_account", { accountId: "a@example.test" });
    assert.equal(result, null);
    assert.equal(existsSync(root), false);
    await assert.rejects(
      () => dispatch("delete_antigravity_account", {}),
      (error: unknown) => error instanceof CommandError,
    );
  });
});