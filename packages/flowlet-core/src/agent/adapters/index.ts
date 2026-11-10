// Agent 全局配置 Adapter 注册表与高层入口。
//
// 权威实现：`src-tauri/src/core/agent_global_config/adapters.rs`。
// 每个 Agent 的 Adapter 独立成文件；这里只做「adapterId → 实现 + 路径解析 + 模型选择」
// 的组合，不承载任何具体配置格式知识。
import type { JsonRow } from "../../types.ts";
import {
  claudeSettingsPath,
  codexAuthPath,
  codexConfigPath,
  codexModelsPath,
  dshHome,
  hermesConfigPath,
  hermesEnvPath,
  opencodeAuthPath,
  opencodePermissionPluginPath,
  opencodeSettingsPath,
  piAuthPath,
  piExtensionPath,
  piModelsPath,
  piSettingsPath,
} from "../paths.ts";
import {
  resolveModelChoices,
  type AgentGlobalConfigOptions,
  type McpServerSpecInput,
} from "../models.ts";
import type { AgentGlobalConfigReport } from "../report.ts";
import { applyClaudeCode, inspectClaudeCode, restoreClaudeCode } from "./claude-code.ts";
import { applyCodex, inspectCodex, restoreCodex } from "./codex.ts";
import { applyDsh, inspectDshAt, restoreDshAt } from "./deepseek-harness.ts";
import { applyHermes, inspectHermes, restoreHermes } from "./hermes.ts";
import { applyOpencode, inspectOpencode, restoreOpencode } from "./opencode.ts";
import { applyPi, inspectPi, restorePi } from "./pi.ts";

export const GLOBAL_CONFIG_ADAPTER_IDS: ReadonlyArray<string> = [
  "claude-code",
  "opencode",
  "pi",
  "codex",
  "deepseek-harness",
  "hermes",
];

function requireAdapter(adapterId: string): string {
  if (!GLOBAL_CONFIG_ADAPTER_IDS.includes(adapterId)) {
    throw new Error(`暂不支持管理 Agent 全局配置：${adapterId}`);
  }
  return adapterId;
}

export function inspectAgentGlobalConfig(
  adapterId: string,
  expectedBaseUrl: string,
): AgentGlobalConfigReport {
  switch (requireAdapter(adapterId)) {
    case "claude-code":
      return inspectClaudeCode(claudeSettingsPath(), expectedBaseUrl);
    case "opencode":
      return inspectOpencode(
        opencodeSettingsPath(),
        opencodeAuthPath(),
        opencodePermissionPluginPath(),
        expectedBaseUrl,
      );
    case "pi":
      return inspectPi(
        {
          settingsPath: piSettingsPath(),
          modelsPath: piModelsPath(),
          authPath: piAuthPath(),
          extensionPath: piExtensionPath(),
        },
        expectedBaseUrl,
      );
    case "codex":
      return inspectCodex(
        {
          configPath: codexConfigPath(),
          authPath: codexAuthPath(),
          modelsPath: codexModelsPath(),
        },
        expectedBaseUrl,
      );
    case "deepseek-harness":
      return inspectDshAt(dshHome(), expectedBaseUrl);
    default:
      return inspectHermes(
        { configPath: hermesConfigPath(), envPath: hermesEnvPath() },
        expectedBaseUrl,
      );
  }
}

export interface ApplyGlobalConfigInput {
  adapterId: string;
  expectedBaseUrl: string;
  clientToken: string;
  options: AgentGlobalConfigOptions | null;
  /** 已解析的 models-cn.json（Codex 动态模型目录使用；缺失时用保守条目）。 */
  modelsCn: JsonRow | null;
}

export function applyAgentGlobalConfig(input: ApplyGlobalConfigInput): AgentGlobalConfigReport {
  const { adapterId, expectedBaseUrl, clientToken, options, modelsCn } = input;
  requireAdapter(adapterId);
  // 与 Rust Adapter 一致：写入前统一解析（主模型，快速模型）；非法模型在写文件前拒绝。
  const choices = resolveModelChoices(options);
  const mcpServers: ReadonlyArray<McpServerSpecInput> | null =
    options !== null && options.mcpServers !== undefined ? options.mcpServers : null;
  switch (adapterId) {
    case "claude-code":
      return applyClaudeCode(
        claudeSettingsPath(),
        expectedBaseUrl,
        clientToken,
        choices.primaryModel,
        choices.fastModel,
      );
    case "opencode":
      return applyOpencode(
        {
          settingsPath: opencodeSettingsPath(),
          authPath: opencodeAuthPath(),
          permissionPluginPath: opencodePermissionPluginPath(),
        },
        expectedBaseUrl,
        clientToken,
        choices.primaryModel,
        choices.fastModel,
      );
    case "pi":
      return applyPi(
        {
          settingsPath: piSettingsPath(),
          modelsPath: piModelsPath(),
          authPath: piAuthPath(),
          extensionPath: piExtensionPath(),
        },
        expectedBaseUrl,
        clientToken,
        options?.sessionExtension === true,
        choices.primaryModel,
        choices.fastModel,
      );
    case "codex":
      return applyCodex(
        {
          configPath: codexConfigPath(),
          authPath: codexAuthPath(),
          modelsPath: codexModelsPath(),
        },
        expectedBaseUrl,
        clientToken,
        choices.primaryModel,
        modelsCn,
      );
    case "deepseek-harness":
      return applyDsh({
        home: dshHome(),
        expectedBaseUrl,
        clientToken,
        sessionExtension: options?.sessionExtension === true,
        primaryModel: choices.primaryModel,
        mcpServers,
      });
    default:
      return applyHermes(
        { configPath: hermesConfigPath(), envPath: hermesEnvPath() },
        expectedBaseUrl,
        clientToken,
        choices.primaryModel,
        options?.sessionExtension,
      );
  }
}

export function restoreAgentGlobalConfig(
  adapterId: string,
  expectedBaseUrl: string,
): AgentGlobalConfigReport {
  switch (requireAdapter(adapterId)) {
    case "claude-code":
      return restoreClaudeCode(claudeSettingsPath(), expectedBaseUrl);
    case "opencode":
      return restoreOpencode(
        {
          settingsPath: opencodeSettingsPath(),
          authPath: opencodeAuthPath(),
          permissionPluginPath: opencodePermissionPluginPath(),
        },
        expectedBaseUrl,
      );
    case "pi":
      return restorePi(
        {
          settingsPath: piSettingsPath(),
          modelsPath: piModelsPath(),
          authPath: piAuthPath(),
          extensionPath: piExtensionPath(),
        },
        expectedBaseUrl,
      );
    case "codex":
      return restoreCodex(
        {
          configPath: codexConfigPath(),
          authPath: codexAuthPath(),
          modelsPath: codexModelsPath(),
        },
        expectedBaseUrl,
      );
    case "deepseek-harness":
      return restoreDshAt(dshHome(), expectedBaseUrl);
    default:
      return restoreHermes(
        { configPath: hermesConfigPath(), envPath: hermesEnvPath() },
        expectedBaseUrl,
      );
  }
}