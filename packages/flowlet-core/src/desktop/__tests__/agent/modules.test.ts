// Agent 底层模块单测：不依赖真实网络/子进程的部分。
//
// 覆盖：
// - Codex OAuth 用量解析（snake_case 字段、credits/reset credits、缺失身份）；
// - Antigravity 本机 server 命令行解析与 summary/model 额度归一；
// - JSONC/TOML/YAML 编辑器的注释保留与幂等；
// - agent 注册表与模型归一的边界。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { parseOauthUsage } from "../../../agent/codex-account.ts";
import {
  fraction,
  modelQuotas,
  parseServer,
  resetAt,
  string,
  summaryQuotas,
  validResponse,
} from "../../../agent/antigravity.ts";
import { jsoncDelete, jsoncSet, parseJsoncObject } from "../../../agent/jsonc.ts";
import {
  parseYamlValue,
  patchYamlEntry,
  yamlAt,
  yamlPlainSafe,
  yamlQuote,
} from "../../../agent/yaml.ts";
import {
  removeTomlProviderTable,
  removeTomlTopLevelValue,
  setTomlProviderTable,
  setTomlTopLevelValue,
} from "../../../agent/toml.ts";
import {
  availableAgentModels,
  canonicalKnownModel,
  catalogDeclaresModel,
  catalogForModel,
  CODEX_MODEL_REQUIRED_FIELDS,
  codexCatalogContent,
  isKnownCatalogModel,
  resolveFastModel,
  resolveModelChoices,
  resolveRequestedModel,
} from "../../../agent/models.ts";
import { agentDescriptor, capabilitiesReport } from "../../../agent/registry.ts";
import {
  DSH_SESSION_BRIDGE_SOURCE,
  HERMES_SESSION_BRIDGE_MANIFEST,
  HERMES_SESSION_BRIDGE_SOURCE,
} from "../../../agent/resources.ts";
import { normalizeUrl, pathsEqual } from "../../../agent/paths.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex OAuth 用量解析", () => {
  it("映射 snake_case 字段与 credits / reset credits", () => {
    const report = parseOauthUsage(
      {
        email: "User@Example.test",
        plan_type: "plus",
        account_id: "acc-1",
        rate_limit: {
          primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1_900_000_000 },
        },
        credits: { has_credits: true, unlimited: false, balance: 42.5 },
        rate_limit_reset_credits: {
          available_count: 2,
          credits: [
            {
              id: "credit-1",
              reset_type: "weekly",
              status: "available",
              granted_at: 100,
              expires_at: 200,
              title: "Weekly reset",
              description: "desc",
            },
          ],
        },
        rate_limit_reached_type: "primary",
      },
      undefined,
    );
    assert.equal(report.account_id, "acc-1");
    assert.equal(report.signed_in, true);
    assert.equal(report.auth_mode, "chatgpt");
    assert.equal(report.source, "oauth");
    assert.equal(report.primary?.used_percent, 12.5);
    assert.equal(report.primary?.window_duration_mins, 300);
    assert.equal(report.secondary?.window_duration_mins, 10080);
    assert.equal(report.credits?.balance, "42.5");
    assert.equal(report.rate_limit_reset_credits?.available_count, 2);
    assert.equal(report.rate_limit_reset_credits?.credits?.[0].reset_type, "weekly");
    assert.equal(report.rate_limit_reached_type, "primary");
  });

  it("缺少账号信息时抛 Rust 对齐错误", () => {
    assert.throws(() => parseOauthUsage({}, undefined), /官方用量接口未返回账号信息/u);
  });

  it("缺 account_id 时回退邮箱/未知身份", () => {
    const report = parseOauthUsage({ email: "a@b.test" }, undefined);
    assert.equal(report.account_id, "a@b.test");
    const fallback = parseOauthUsage({ plan_type: "pro" }, undefined);
    assert.equal(fallback.account_id, "unknown-account");
  });
});

describe("Antigravity 本机观测", () => {
  it("进程命令行必须同时含 antigravity 与 language_server，并解析带引号参数", () => {
    assert.equal(parseServer(1, "/windsurf/language_server --csrf_token secret"), null);
    assert.equal(parseServer(1, "/antigravity/renderer --csrf_token secret"), null);
    assert.equal(parseServer(1, "/antigravity/language_server"), null);
    const server = parseServer(
      42,
      '"C:\\Antigravity\\language_server.exe" --csrf_token=secret --extension_server_port 1234 --extension_server_csrf_token "other"',
    );
    assert.ok(server !== null);
    assert.equal(server.csrf, "secret");
    assert.equal(server.extensionPort, 1234);
    assert.equal(server.extensionCsrf, "other");
  });

  it("summary 额度保留 disabled/未知 bucket 并支持 oneof", () => {
    const quotas = summaryQuotas({
      response: {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "weekly", remaining: { remainingFraction: 0.25 } },
              { bucketId: "session", remaining: { case: "remainingFraction", value: 1.4 } },
              { bucketId: "unknown", disabled: true },
            ],
          },
        ],
      },
    });
    assert.equal(quotas.length, 3);
    assert.equal(quotas[0].label, "Gemini · weekly");
    assert.equal(quotas[0].remaining_fraction, 0.25);
    assert.equal(quotas[1].remaining_fraction, 1);
    assert.equal(quotas[2].remaining_fraction, null);
    assert.equal(quotas[2].disabled, true);
    assert.deepEqual(summaryQuotas({ code: "unauthenticated", groups: [] }), []);
  });

  it("legacy model 额度不伪造 100%", () => {
    const quotas = modelQuotas({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: "Gemini",
              modelOrAlias: { model: "gemini" },
              quotaInfo: { remainingFraction: 0, resetTime: "2026-11-07T00:00:00Z" },
            },
            { label: "Claude", quotaInfo: { resetTime: "1794009600" } },
            { label: "No quota" },
          ],
        },
      },
    });
    assert.equal(quotas.length, 2);
    assert.equal(quotas[0].remaining_fraction, 0);
    assert.ok(quotas[1].reset_at?.startsWith("2026-"));
    assert.equal(quotas[1].remaining_fraction, null);
  });

  it("纯量与时间归一", () => {
    assert.equal(string("  x  "), "x");
    assert.equal(string("   "), null);
    assert.equal(fraction(-1), 0);
    assert.equal(fraction(2), 1);
    assert.equal(fraction(Number.NaN), null);
    assert.equal(resetAt(1_794_009_600), new Date(1_794_009_600_000).toISOString());
    assert.equal(validResponse({ code: "ok" }), true);
    assert.equal(validResponse({ code: "nope" }), false);
    assert.equal(validResponse("x"), false);
  });
});

describe("JSONC 编辑保留注释", () => {
  it("删除属性不吞掉相邻行尾注释，值被替换时保留注释", () => {
    const text = [
      "{",
      '  "theme": "dark", // keep theme comment',
      '  "env": {',
      '    "FOO": "bar", // foo comment',
      '    "API_KEY": "x",',
      '    "BASE_URL": "https://api.anthropic.com"',
      "  }",
      "}",
      "",
    ].join("\n");
    const withoutKey = jsoncDelete(text, ["env", "API_KEY"]);
    assert.ok(withoutKey.includes("// foo comment"));
    assert.ok(!withoutKey.includes('"API_KEY"'));
    parseJsoncObject(withoutKey, "test");
    const replaced = jsoncSet(withoutKey, ["env", "BASE_URL"], "http://127.0.0.1:1");
    parseJsoncObject(replaced, "test");
    assert.ok(replaced.includes("// foo comment"));
    assert.ok(replaced.includes("http://127.0.0.1:1"));
    // 删除最后一个键时同时移除前面的逗号，保持文档合法。
    const lastKeyRemoved = jsoncDelete(replaced, ["env", "BASE_URL"]);
    parseJsoncObject(lastKeyRemoved, "test");
  });

  it("不存在的属性删除是幂等的", () => {
    const text = '{\n  "a": 1\n}\n';
    assert.equal(jsoncDelete(text, ["missing"]), text);
  });

  it("语法错误抛出可读异常", () => {
    assert.throws(() => parseJsoncObject("{", "x.json"), /解析失败|JSON 解析失败/u);
  });
});

describe("TOML 行级编辑", () => {
  it("替换顶层键保留缩进与行尾注释", () => {
    const text = '# head\nmodel = "gpt-5" # user comment\n\n[model_providers.other]\nname = "other"\n';
    const updated = setTomlTopLevelValue(text, "model", "glm-5.3");
    assert.ok(updated.includes('# head'));
    assert.ok(updated.includes('model = "glm-5.3" # user comment'));
  });

  it("缺失的顶层键插入在第一个表头之前", () => {
    const text = '# head\nmodel = "gpt-5"\n\n[model_providers.other]\nname = "other"\n';
    const updated = setTomlTopLevelValue(text, "model_provider", "flowlet");
    const lines = updated.split("\n");
    assert.ok(lines.indexOf('model_provider = "flowlet"') < lines.indexOf("[model_providers.other]"));
    assert.ok(updated.endsWith("\n"));
  });

  it("删除顶层键保留其它行", () => {
    const text = '# head\nmodel = "gpt-5"\napproval_policy = "never"\n';
    const updated = removeTomlTopLevelValue(text, "model");
    assert.equal(updated, '# head\napproval_policy = "never"\n');
  });

  it("新增 provider 表追加到文件末尾，删除后回到原样", () => {
    const text = '# head\nmodel = "gpt-5"\n';
    const added = setTomlProviderTable(text, "flowlet", {
      name: "flowlet",
      base_url: "http://127.0.0.1:18640/v1",
      wire_api: "responses",
      requires_openai_auth: true,
    });
    assert.ok(added.includes("[model_providers.flowlet]"));
    assert.equal(removeTomlProviderTable(added, "flowlet"), text);
  });

  it("行内 model_providers 写法显式报错而不是破坏文件", () => {
    assert.throws(
      () => setTomlProviderTable('model_providers = { other = { name = "x" } }\n', "flowlet", { name: "flowlet" }),
      /行内表写法/u,
    );
  });
});

describe("YAML Document 编辑", () => {
  it("设置/删除嵌套键保留注释与其它内容", () => {
    const text = "# head\nui:\n  theme: dark\nmodel:\n  default: old\n";
    const patched = patchYamlEntry(text, "config.yaml", ["model"], "provider", "custom");
    assert.ok(patched.includes("# head"));
    assert.ok(patched.includes("theme: dark"));
    assert.ok(patched.includes("default: old"), "同层其它键必须保留");
    const without = patchYamlEntry(patched, "config.yaml", ["model"], "provider", undefined);
    assert.ok(!without.includes("provider:"));
    parseYamlValue(without);
  });

  it("父键是空串哨兵时拒绝改写（由 Adapter 先剥离哨兵）", () => {
    assert.throws(
      () => patchYamlEntry('model: ""\n', "config.yaml", ["model"], "provider", "custom"),
      /必须是 YAML 对象/u,
    );
  });

  it("父键是标量时拒绝改写", () => {
    assert.throws(
      () => patchYamlEntry("model: 1\n", "config.yaml", ["model"], "provider", "custom"),
      /必须是 YAML 对象/u,
    );
  });

  it("yamlAt 支持数字索引与缺失路径", () => {
    const root = { a: { list: [{ id: "x" }] } };
    assert.equal(yamlAt(root, ["a", "list", "0", "id"]), "x");
    assert.equal(yamlAt(root, ["a", "missing", "x"]), undefined);
  });

  it("YAML 纯量引用规则与 Rust 一致", () => {
    assert.equal(yamlQuote("simple-value"), "simple-value");
    assert.equal(yamlQuote("with space"), "'with space'");
    assert.equal(yamlQuote("true"), "'true'");
    assert.equal(yamlQuote("123"), "'123'");
    assert.equal(yamlQuote("a'b"), "'a''b'");
    assert.equal(yamlPlainSafe("a: b"), false);
  });
});

describe("Agent 模型解析与 Codex 目录", () => {
  it("规范模型归一：别名与大小写变体，未知模型拒绝", () => {
    assert.equal(canonicalKnownModel("deepseek-flash"), "deepseek-v4.1-flash");
    assert.equal(canonicalKnownModel("GLM-5.3"), "glm-5.3");
    assert.equal(isKnownCatalogModel("flowlet-pro"), false);
    assert.throws(() => canonicalKnownModel("flowlet-pro"), /不在 Flowlet 模型目录中/u);
  });

  it("resolveModelChoices 拒绝空主模型、快速模型缺省等于主模型", () => {
    assert.throws(() => resolveModelChoices(null), /未指定默认模型/u);
    assert.throws(() => resolveModelChoices({ primaryModel: "  " }), /未指定默认模型/u);
    assert.deepEqual(resolveModelChoices({ primaryModel: "glm-5.3" }), {
      primaryModel: "glm-5.3",
      fastModel: "glm-5.3",
    });
    assert.deepEqual(resolveModelChoices({ primaryModel: "glm-5.3", fastModel: "LongCat-2.5" }), {
      primaryModel: "glm-5.3",
      fastModel: "LongCat-2.5",
    });
    assert.equal(resolveFastModel("  ", "glm-5.3"), "glm-5.3");
  });

  it("resolveRequestedModel 缺省取字典序第一个可用模型", () => {
    assert.equal(resolveRequestedModel(null, ["LongCat-2.5", "glm-5.3"]), "LongCat-2.5");
    assert.throws(() => resolveRequestedModel(null, []), /没有可用的开放模型/u);
  });

  it("availableAgentModels 要求路由启用 + 协议匹配 + 账号/channel 可用", () => {
    const snapshot = {
      channels: [
        {
          id: "openai-api",
          enabled: true,
          supported_protocols: ["openai", "responses", "anthropic"],
        },
      ],
      accounts: [{ id: "acc-1", enabled: true, api_key: "sk", credential_status: "healthy" }],
      routes: [
        {
          virtual_model_id: "glm-5.3",
          channel_id: "openai-api",
          account_id: "acc-1",
          client_protocol: "responses",
          enabled: true,
        },
        {
          virtual_model_id: "LongCat-2.5",
          channel_id: "openai-api",
          account_id: "acc-1",
          client_protocol: "anthropic",
          enabled: true,
        },
        {
          virtual_model_id: "flowlet-pro",
          channel_id: "openai-api",
          account_id: "acc-1",
          client_protocol: "responses",
          enabled: true,
        },
      ],
    };
    assert.deepEqual(availableAgentModels(snapshot, ["responses"]), ["glm-5.3"]);
    assert.deepEqual(availableAgentModels(snapshot, ["anthropic"]), ["LongCat-2.5"]);
    assert.deepEqual(availableAgentModels({ ...snapshot, accounts: [] }, ["responses"]), []);
  });

  it("Codex 模型目录包含全部必需字段且未知模型回退保守条目", () => {
    const catalog = catalogForModel(null, "glm-5.3");
    const models = catalog.models as Array<Record<string, unknown>>;
    assert.equal(models.length, 1);
    const entry = models[0];
    for (const field of CODEX_MODEL_REQUIRED_FIELDS) {
      assert.ok(field in entry, `缺少必需字段 ${field}`);
    }
    assert.equal(entry.context_window, 128000);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.default_reasoning_level, "medium");
    const content = codexCatalogContent(null, "glm-5.3");
    assert.ok(content.endsWith("\n"));
    assert.equal(catalogDeclaresModel(content, "glm-5.3"), true);
    assert.equal(catalogDeclaresModel(content, "other"), false);
    assert.equal(catalogDeclaresModel("{not json", "glm-5.3"), false);
  });
});

describe("内嵌受管插件资源", () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../..",
  );

  it("内嵌源码与 src-tauri/resources/agent-plugins 上游文件逐字一致", () => {
    const upstream = (relative: string): string =>
      readFileSync(path.join(REPO_ROOT, "src-tauri", "resources", "agent-plugins", relative), "utf8");
    assert.equal(
      DSH_SESSION_BRIDGE_SOURCE,
      upstream("deepseek-harness/flowlet-session-bridge.mjs"),
      "DSH 会话桥源码漂移：修改上游后必须同步 agent/resources.ts",
    );
    assert.equal(
      HERMES_SESSION_BRIDGE_MANIFEST,
      upstream("hermes/plugin.yaml"),
      "Hermes 插件清单漂移：修改上游后必须同步 agent/resources.ts",
    );
    assert.equal(
      HERMES_SESSION_BRIDGE_SOURCE,
      upstream("hermes/__init__.py"),
      "Hermes 插件源码漂移：修改上游后必须同步 agent/resources.ts",
    );
  });
});

describe("Agent 注册表与路径归一", () => {
  it("capabilities 报告覆盖 6 个 Agent，环境/配置适配器 id 与 Rust Bundle 一致", () => {
    const report = capabilitiesReport();
    const agents = report.agents as Array<Record<string, unknown>>;
    assert.deepEqual(
      agents.map((agent) => agent.id),
      ["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"],
    );
    assert.equal(agentDescriptor("codex")?.environmentAdapterId, "chatgpt-desktop");
    assert.equal(agentDescriptor("codex")?.endpointSuffix, "/v1");
    assert.equal(agentDescriptor("claude-code")?.endpointSuffix, "/anthropic");
    assert.equal(agentDescriptor("missing"), undefined);
  });

  it("URL 归一与路径比较", () => {
    assert.equal(normalizeUrl(" HTTP://127.0.0.1:18640/V1/ "), "http://127.0.0.1:18640/v1");
    const dir = mkdtempSync(path.join(tmpdir(), "flowlet-paths-"));
    tempDirs.push(dir);
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{}");
    assert.equal(pathsEqual(file, file), true);
    assert.equal(pathsEqual(file, path.join(dir, "other.json")), false);
  });
});