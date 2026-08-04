import { useEffect, useMemo, useState } from "react";
import { Button, Select, SideSheet, Switch, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import styles from "./AgentAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { ConfigRow, StatusRow, globalConfigTag } from "./globalConfigPresentation";
import type {
  AgentEnvironmentReport,
  AgentGlobalConfigOptions,
  AgentGlobalConfigReport,
  AgentInstallMethod,
} from "../../domains/agent/types";

const { Text, Title } = Typography;
const MASKED_TOKEN = "••••••••••••••••••••";
const OPENCODE_PERMISSION_PLUGIN_SNIPPET = `// 保存为 ~/.config/opencode/plugins/flowlet.ts
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

export const FlowletPermissionBridge = async ({ client, serverUrl, directory, worktree }) => {
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) return {}
  const root = path.join(home, ".flowlet", "opencode-control")
  const instanceKey = createHash("sha256")
    .update(String(directory || worktree || serverUrl))
    .digest("hex")
    .slice(0, 12)
  const statePath = path.join(root, \`state-\${process.pid}-\${instanceKey}.json\`)
  const stateTempPath = \`\${statePath}.tmp\`
  const permissions = new Map()
  const normalizePermission = (value) => ({
    id: value.id,
    sessionID: value.sessionID,
    permission: value.permission || value.type || "unknown",
    patterns: value.patterns || (Array.isArray(value.pattern) ? value.pattern : value.pattern ? [value.pattern] : []),
    metadata: value.metadata || {},
    always: value.always || [],
    tool: value.tool || (value.messageID ? { messageID: value.messageID, callID: value.callID || "" } : undefined),
  })
  await mkdir(root, { recursive: true })
  try {
    const response = await client.permission?.list?.()
    const pending = Array.isArray(response) ? response : response?.data
    if (Array.isArray(pending)) {
      for (const value of pending) permissions.set(value.id, normalizePermission(value))
    }
  } catch {}
  let persistQueue = Promise.resolve()
  const persist = () => {
    const snapshot = JSON.stringify({
      pid: process.pid,
      serverUrl: String(serverUrl),
      updatedAt: Date.now(),
      permissions: [...permissions.values()],
    })
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await writeFile(stateTempPath, snapshot, "utf8")
      await rename(stateTempPath, statePath)
    })
    return persistQueue
  }
  await persist()
  const consumeReplies = async () => {
    for (const name of await readdir(root)) {
      if (!name.startsWith("reply-") || !name.endsWith(".json")) continue
      const replyPath = path.join(root, name)
      try {
        const command = JSON.parse(await readFile(replyPath, "utf8"))
        const permission = permissions.get(command.permissionId)
        if (!permission) continue
        if (client.permission?.reply) {
          await client.permission.reply({ requestID: command.permissionId, reply: command.reply })
        } else if (client.postSessionIdPermissionsPermissionId) {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: permission.sessionID, permissionID: command.permissionId },
            body: { response: command.reply },
          })
        } else {
          throw new Error("当前 OpenCode SDK 不支持 permission.reply")
        }
        await unlink(replyPath)
      } catch {}
    }
  }
  const heartbeat = setInterval(() => {
    void persist()
    void consumeReplies()
  }, 500)
  return {
    event: async ({ event }) => {
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        permissions.set(event.properties.id, normalizePermission(event.properties))
        await persist()
      } else if (event.type === "permission.replied") {
        permissions.delete(event.properties.requestID || event.properties.permissionID)
        await persist()
      }
    },
    dispose: async () => {
      clearInterval(heartbeat)
      await persistQueue.catch(() => {})
      try { await unlink(statePath) } catch {}
      try { await unlink(stateTempPath) } catch {}
    },
  }
}
`;

// Codex 模型目录内容，与仓库根目录 codex-models.json（Rust include_str! 内置）保持一致。
// 声明 flowlet-pro / flowlet-flash 的上下文窗口与推理档位，供 config.toml 的
// model_catalog_json 指向生成到 ~/.codex/model-catalog.flowlet.json。
const CODEX_MODEL_CATALOG_JSON = "{\n  \"models\": [\n    {\n      \"slug\": \"flowlet-pro\",\n      \"display_name\": \"Flowlet Pro\",\n      \"description\": \"Flowlet aggregated coding model routed to available accounts.\",\n      \"default_reasoning_level\": \"high\",\n      \"supported_reasoning_levels\": [\n        {\n          \"effort\": \"low\",\n          \"description\": \"Fast responses with lighter reasoning\"\n        },\n        {\n          \"effort\": \"high\",\n          \"description\": \"Extra high reasoning depth for complex problems\"\n        },\n        {\n          \"effort\": \"max\",\n          \"description\": \"Maximum reasoning depth for the hardest problems\"\n        }\n      ],\n      \"context_window\": 1048576,\n      \"supported_in_api\": true\n    },\n    {\n      \"slug\": \"flowlet-flash\",\n      \"display_name\": \"Flowlet Flash\",\n      \"description\": \"Flowlet aggregated fast model routed to available accounts.\",\n      \"default_reasoning_level\": \"low\",\n      \"supported_reasoning_levels\": [\n        {\n          \"effort\": \"low\",\n          \"description\": \"Fast responses with lighter reasoning\"\n        },\n        {\n          \"effort\": \"high\",\n          \"description\": \"Extra high reasoning depth for complex problems\"\n        },\n        {\n          \"effort\": \"max\",\n          \"description\": \"Maximum reasoning depth for the hardest problems\"\n        }\n      ],\n      \"context_window\": 1048576,\n      \"supported_in_api\": true\n    }\n  ]\n}";

export type AgentKind = "claude-code" | "opencode" | "pi" | "codex";
type Copy = (value: string, message: string) => Promise<void>;

type AgentMeta = {
  name: string;
  endpointSuffix: "/anthropic" | "/v1";
  hasDesktop: boolean;
  showsCredentialsFile: boolean;
  showsFastModel: boolean;
  showsSubagentModel: boolean;
  environmentDescription: string;
  notInstalledText: string;
  globalConfigDescription: string;
  manualDescription: string;
  restartTip: string;
};

const AGENT_META: Record<AgentKind, AgentMeta> = {
  "claude-code": {
    name: "Claude Code",
    endpointSuffix: "/anthropic",
    hasDesktop: false,
    showsCredentialsFile: false,
    showsFastModel: true,
    showsSubagentModel: true,
    environmentDescription: "识别 Claude Code 的安装位置、版本和安装方式",
    notInstalledText: "未检测到 Claude Code。Flowlet 会检查 PATH 和官方常见安装位置。",
    globalConfigDescription: "配置后可从任意终端或 IDE 启动 Claude Code",
    manualDescription: "以下内容与一键写入的 Claude Code 全局配置一致",
    restartTip: "修改全局配置后请重新启动 Claude Code。",
  },
  opencode: {
    name: "OpenCode",
    endpointSuffix: "/v1",
    hasDesktop: true,
    showsCredentialsFile: true,
    showsFastModel: true,
    showsSubagentModel: false,
    environmentDescription: "识别 OpenCode CLI 与 Desktop 的安装位置和版本",
    notInstalledText: "未检测到 OpenCode CLI 或 Desktop。Flowlet 会检查 PATH 和常见安装位置。",
    globalConfigDescription: "OpenCode CLI 与 Desktop 共用此全局配置",
    manualDescription: "OpenCode 的 Provider 配置与凭据文件需要分别设置",
    restartTip: "修改全局配置后请重新启动 OpenCode CLI 与 Desktop。",
  },
  pi: {
    name: "Pi",
    endpointSuffix: "/v1",
    hasDesktop: false,
    showsCredentialsFile: true,
    showsFastModel: false,
    showsSubagentModel: false,
    environmentDescription: "识别 Pi CLI 的安装位置和版本",
    notInstalledText: "未检测到 Pi。Flowlet 会检查 PATH 和常见安装位置。",
    globalConfigDescription: "Pi 的 Provider 定义在 models.json，凭据在 auth.json，默认模型在 settings.json",
    manualDescription: "Pi 的 models.json、auth.json 与 settings.json 需要分别设置",
    restartTip: "修改全局配置后请重新启动 Pi。",
  },
  codex: {
    name: "Codex",
    endpointSuffix: "/v1",
    hasDesktop: true,
    showsCredentialsFile: true,
    showsFastModel: false,
    showsSubagentModel: false,
    environmentDescription: "识别 Codex CLI 与 ChatGPT Desktop 的安装位置和版本",
    notInstalledText: "未检测到 Codex CLI 或 ChatGPT Desktop。Flowlet 会检查 PATH 与常见安装位置。",
    globalConfigDescription: "Codex CLI、ChatGPT 桌面端与 VS Code 插件共用此全局配置",
    manualDescription: "以下内容与一键写入的 Codex 全局配置一致",
    restartTip: "修改全局配置后请重新启动 Codex CLI 与 ChatGPT Desktop。",
  },
};

type Props = {
  visible: boolean;
  agent: AgentKind;
  baseUrl: string;
  clientToken?: string | null;
  environment?: AgentEnvironmentReport;
  environmentLoading?: boolean;
  environmentError?: string;
  onRefreshEnvironment: () => void;
  globalConfig?: AgentGlobalConfigReport;
  globalConfigLoading?: boolean;
  globalConfigBusy?: boolean;
  globalConfigError?: string;
  onRefreshGlobalConfig: () => void;
  onApplyGlobalConfig: (options?: AgentGlobalConfigOptions) => Promise<void>;
  onRestoreGlobalConfig: () => Promise<void>;
  onClose: () => void;
  onCopy: Copy;
};

export function AgentAccessSideSheet({
  visible,
  agent,
  baseUrl,
  clientToken,
  environment,
  environmentLoading = false,
  environmentError,
  onRefreshEnvironment,
  globalConfig,
  globalConfigLoading = false,
  globalConfigBusy = false,
  globalConfigError,
  onRefreshGlobalConfig,
  onApplyGlobalConfig,
  onRestoreGlobalConfig,
  onClose,
  onCopy,
}: Props) {
  const { t } = useAppPreferences();
  const [surface, setSurface] = useState<"cli" | "desktop">("cli");

  const meta = AGENT_META[agent];
  const name = meta.name;
  const endpoint = `${baseUrl}${meta.endpointSuffix}`;
  const token = clientToken || "<Client Token>";
  const displayedToken = clientToken ? MASKED_TOKEN : token;
  // 1M 长上下文是 Claude Code 专属配置：主模型环境变量是否带 [1m] 后缀。
  const longContext = agent === "claude-code" && (globalConfig?.long_context ?? false);
  const manualSnippets = useMemo(
    () => buildManualSnippets(agent, endpoint, token, displayedToken, longContext, t),
    [agent, displayedToken, endpoint, longContext, t, token],
  );

  useEffect(() => {
    setSurface("cli");
  }, [visible, agent]);

  const surfaceInstallations = environment?.installations.filter(
    (installation) => (installation.surface || "cli") === surface,
  );

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={
        <Tabs
          className={styles.titleTabs}
          type="line"
          activeKey={surface}
          tabPaneMotion={false}
          onChange={(key) => setSurface(key as "cli" | "desktop")}
        >
          <Tabs.TabPane tab={t("{name} CLI 接入", { name })} itemKey="cli" />
          {meta.hasDesktop ? (
            <Tabs.TabPane tab={t("{name} Desktop 接入", { name })} itemKey="desktop" />
          ) : null}
        </Tabs>
      }
      headerStyle={{ paddingBottom: 0 }}
      width="min(760px, 96vw)"
      footer={null}
      bodyStyle={{ padding: 0 }}
      onCancel={onClose}
    >
      <div className={styles.body}>
        <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <Title heading={5}>{t("本机环境")}</Title>
                <Text type="tertiary" size="small">
                  {t(meta.environmentDescription)}
                </Text>
              </div>
              <Button
                icon={<IconRefresh spin={environmentLoading} />}
                loading={environmentLoading}
                theme="light"
                onClick={onRefreshEnvironment}
              >
                {t("重新检测")}
              </Button>
            </div>

            {environmentError ? <Text className={styles.environmentMessage} type="danger">{t("检测失败：{message}", { message: environmentError })}</Text> : null}
            {!environmentError && !environmentLoading && !environment?.installed ? (
              <Text className={styles.environmentMessage} type="tertiary">
                {t(meta.notInstalledText)}
              </Text>
            ) : null}
            {!environmentError && !environmentLoading && environment?.installed && !surfaceInstallations?.length ? (
              <Text className={styles.environmentMessage} type="tertiary">
                {t("未检测到 {surface} 安装。", { surface: t(surface === "desktop" ? "Desktop" : "CLI") })}
              </Text>
            ) : null}
            {surfaceInstallations?.map((installation, index) => {
              const duplicateSurface = surfaceInstallations
                .slice(0, index)
                .some((candidate) => (candidate.surface || "cli") === (installation.surface || "cli"));
              return (
              <div className={styles.installation} key={installation.executable_path}>
                <div className={styles.installationHeader}>
                  <strong>{installationTitle(agent, installation.surface, installation.version, t)}</strong>
                  <span className={styles.installationTags}>
                    {environment?.primary?.executable_path === installation.executable_path && installation.surface !== "desktop" && !installation.error ? <Tag color="blue">{t("当前使用")}</Tag> : null}
                    <Tag>{installMethodLabel(installation.install_method, t)}</Tag>
                    {duplicateSurface ? <Tag color="orange">{t("额外安装")}</Tag> : null}
                  </span>
                </div>
                <InstallationPathRow
                  executablePath={installation.executable_path}
                  installDir={installation.install_dir}
                  onCopy={onCopy}
                />
                {installation.error ? <Text className={styles.installationError} type="warning">{installation.error}</Text> : null}
              </div>
              );
            })}
        </section>

        <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <Title heading={5}>{t("全局配置")}</Title>
                <Text type="tertiary" size="small">
                  {t(meta.globalConfigDescription)}
                </Text>
              </div>
              <Button
                icon={<IconRefresh spin={globalConfigLoading} />}
                loading={globalConfigLoading}
                theme="borderless"
                onClick={onRefreshGlobalConfig}
              >
                {t("重新读取")}
              </Button>
            </div>

            {globalConfigError ? <Text className={styles.environmentMessage} type="danger">{t("读取全局配置失败：{message}", { message: globalConfigError })}</Text> : null}
            {globalConfig ? (
              <div className={styles.globalConfig}>
                <div className={styles.globalConfigStatus}>
                  <span>{t("当前状态")}</span>
                  <Tag color={globalConfigTag(globalConfig.state).color}>{t(globalConfigTag(globalConfig.state).label)}</Tag>
                </div>
                <ConfigRow
                  label={t("配置文件")}
                  value={globalConfig.settings_path}
                  onCopy={() => onCopy(globalConfig.settings_path, t("{label} 已复制", { label: t("配置文件") }))}
                />
                {meta.showsCredentialsFile && globalConfig.credentials_path ? (
                  <ConfigRow
                    label={t("凭据文件")}
                    value={globalConfig.credentials_path}
                    onCopy={() => onCopy(globalConfig.credentials_path || "", t("{label} 已复制", { label: t("凭据文件") }))}
                  />
                ) : null}
                {globalConfig.base_url ? <StatusRow label="Base URL" value={globalConfig.base_url} /> : null}
                <StatusRow label="Client Token" value={t(globalConfig.auth_token_configured ? "已配置（内容已隐藏）" : "未配置")} />
                <StatusRow label={t("主模型")} value={globalConfig.primary_model || "-"} />
                {agent === "codex" ? (
                  <StatusRow
                    label={t("模型目录")}
                    value={t(globalConfig.model_catalog_configured ? "已配置" : "未配置")}
                  />
                ) : null}
                {meta.showsFastModel ? <StatusRow label={t("快速模型")} value={globalConfig.fast_model || "-"} /> : null}
                {meta.showsSubagentModel ? <StatusRow label={t("子 Agent 模型")} value={globalConfig.subagent_model || "-"} /> : null}
                {agent === "opencode" ? (
                  <StatusRow
                    label={t("权限插件")}
                    value={t(globalConfig.opencode_permission_bridge ? "已安装" : "需安装或更新")}
                  />
                ) : null}
                {agent === "claude-code" ? (
                  <div className={styles.longContextRow}>
                    <div>
                      <strong>{t("1M 长上下文")}</strong>
                      <small>{t("为主模型写入 [1m] 后缀，Claude Code 长会话按百万级上下文窗口管理。")}</small>
                      <small>{t("Flowlet 实际可用上下文取决于当前路由模型；仅当路由模型支持 1M 时，此配置才能完整生效。")}</small>
                    </div>
                    <Switch
                      checked={globalConfig.long_context ?? false}
                      disabled={globalConfigBusy || globalConfig.state === "invalid" || !clientToken}
                      loading={globalConfigBusy}
                      aria-label={t("1M 长上下文")}
                      onChange={(checked) => void onApplyGlobalConfig({ longContext: checked })}
                    />
                  </div>
                ) : null}
                {agent === "pi" ? (
                  <div className={styles.longContextRow}>
                    <div>
                      <strong>{t("会话扩展")}</strong>
                      <small>{t("安装后可为请求注入会话标识，Flowlet 按会话归并请求；未安装则无法做会话维度串联。")}</small>
                      <small>{t("Pi 仍可作为 Flowlet 客户端使用，仅会话维度数据不可用。")}</small>
                    </div>
                    <Switch
                      checked={globalConfig.session_extension ?? true}
                      disabled={globalConfigBusy || globalConfig.state === "invalid" || !clientToken}
                      loading={globalConfigBusy}
                      aria-label={t("会话扩展")}
                      onChange={(checked) => void onApplyGlobalConfig({ sessionExtension: checked })}
                    />
                  </div>
                ) : null}
                {globalConfig.error ? <Text type="danger">{globalConfig.error}</Text> : null}
                {globalConfig.external_environment_overrides.length ? (
                  <div className={styles.configWarning}>
                    <strong>{t("检测到外部环境变量覆盖")}</strong>
                    <span>{globalConfig.external_environment_overrides.join(", ")}</span>
                    <small>{t("这些变量可能覆盖全局配置，请清理后重新启动对应客户端。")}</small>
                  </div>
                ) : null}
                {globalConfig.state === "other_gateway" ? (
                  <Text className={styles.configNotice} type="warning">
                    {t("当前配置指向其他网关。接入 Flowlet 前会备份原值，之后可以恢复。")}
                  </Text>
                ) : null}
                <div className={styles.configActions}>
                  <Button
                    type="primary"
                    theme="solid"
                    loading={globalConfigBusy}
                    disabled={globalConfig.state === "invalid" || !clientToken}
                    onClick={() => void onApplyGlobalConfig(
                      agent === "claude-code"
                        ? { longContext: globalConfig.long_context ?? false }
                        : agent === "pi"
                          ? { sessionExtension: globalConfig.session_extension ?? true }
                          : undefined,
                    )}
                  >
                    {t(globalConfig.state === "flowlet" ? "重新写入 Flowlet 配置" : globalConfig.state === "other_gateway" ? "覆盖并接入 Flowlet" : "全局接入 Flowlet")}
                  </Button>
                  {globalConfig.backup_available ? (
                    <Button disabled={globalConfigBusy} onClick={() => void onRestoreGlobalConfig()}>{t("恢复接入前配置")}</Button>
                  ) : null}
                </div>
              </div>
            ) : null}
        </section>

        <section className={styles.section}>
          <Title heading={5}>{t("手动配置")}</Title>
          <Text type="tertiary" size="small">
            {t(meta.manualDescription)}
          </Text>
          <div className={styles.snippetList}>
            {manualSnippets.map((snippet) => (
              <div className={styles.snippet} key={snippet.label}>
                <div className={styles.snippetHeader}>
                  <strong>{snippet.label}</strong>
                  <Button
                    aria-label={t("复制{label}", { label: snippet.label })}
                    icon={<IconCopy />}
                    theme="light"
                    onClick={() => void onCopy(snippet.copyValue, t("{label} 已复制", { label: snippet.label }))}
                  >
                    {t("复制此片段")}
                  </Button>
                </div>
                <pre className={styles.codeBlock}><code>{snippet.displayValue}</code></pre>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.tip}>
          <Title heading={5}>{t("使用提示")}</Title>
          <ul>
            <li>{t("Client Token 用于访问本地 Flowlet，不是上游渠道的 API Key。")}</li>
            <li>{t(meta.restartTip)}</li>
            {!clientToken ? <li>{t("当前未配置默认 Client Token，请先在客户端设置中完成配置。")}</li> : null}
          </ul>
        </section>
      </div>
    </SideSheet>
  );
}

function installMethodLabel(method: AgentInstallMethod, t: (source: string) => string) {
  const labels: Record<AgentInstallMethod, string> = {
    native: "原生安装",
    winget: "WinGet",
    npm: "npm 全局安装",
    bun: "Bun 安装",
    legacy_npm: "旧版 npm 安装",
    homebrew: "Homebrew",
    system_package: "系统包管理器",
    desktop: "桌面应用",
    unknown: "未知方式",
  };
  return t(labels[method]);
}

function installationTitle(
  agent: AgentKind,
  surface: "cli" | "desktop" | undefined,
  version: string | null | undefined,
  t: (source: string) => string,
) {
  const base = AGENT_META[agent].name;
  // Codex 桌面端探测到的是 ChatGPT 桌面应用，保留真实应用名便于识别。
  const name = agent === "claude-code"
    ? "Claude Code"
    : agent === "codex" && surface === "desktop"
      ? "ChatGPT Desktop"
      : surface === "desktop"
        ? `${base} Desktop`
        : `${base} CLI`;
  return version ? `${name} ${version}` : t(`${name} 安装`);
}

function buildManualSnippets(
  agent: AgentKind,
  endpoint: string,
  token: string,
  displayedToken: string,
  longContext: boolean,
  t: (source: string) => string,
) {
  if (agent === "claude-code") {
    // 与一键写入保持一致：开启 1M 长上下文时主模型带 [1m] 后缀。
    const primaryModel = longContext ? "flowlet-pro[1m]" : "flowlet-pro";
    const value = (authToken: string) => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_FABLE_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: primaryModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "flowlet-flash",
        ANTHROPIC_SMALL_FAST_MODEL: "flowlet-flash",
        CLAUDE_CODE_SUBAGENT_MODEL: "flowlet-flash",
      },
    }, null, 2);
    return [{
      label: t("settings.json 配置片段"),
      displayValue: value(displayedToken),
      copyValue: value(token),
    }];
  }
  if (agent === "pi") {
    const modelsConfig = JSON.stringify({
      providers: {
        flowlet: {
          baseUrl: endpoint,
          api: "openai-completions",
          headers: { "x-flowlet-client": "pi" },
          models: [
            { id: "flowlet-pro", name: "flowlet-pro" },
            { id: "flowlet-flash", name: "flowlet-flash" },
          ],
        },
      },
    }, null, 2);
    const credentials = (apiKey: string) => JSON.stringify({
      flowlet: { type: "api_key", key: apiKey },
    }, null, 2);
    const defaults = JSON.stringify({
      defaultProvider: "flowlet",
      defaultModel: "flowlet-pro",
    }, null, 2);
    // 会话扩展：Pi 走 OpenAI 兼容 SDK，原生请求不带会话标识，需额外部署该扩展
    // 才能让 Flowlet 把 Pi 请求按会话归并（与一键写入功能写入的扩展相同）。
    const sessionExtension = [
      "// 保存为 ~/.pi/agent/extensions/flowlet.ts，Pi 启动时自动加载（无需编译）。",
      "// 作用：为发往 Flowlet 渠道的请求注入 x-flowlet-session 头（值为当前会话 UUID），",
      "// 使 Flowlet 能按会话归并请求；该头仅用于本地归属，Flowlet 转发上游前会将其剥离。",
      'export default function (pi) {',
      '  pi.on("before_provider_headers", (event, ctx) => {',
      '    if (event.headers?.["x-flowlet-client"] !== "pi") return;',
      "    try {",
      '      const sessionId = ctx?.sessionManager?.getSessionId?.();',
      '      if (typeof sessionId === "string" && sessionId.length > 0) {',
      '        event.headers["x-flowlet-session"] = sessionId;',
      "      }",
      "    } catch {}",
      "  });",
      "}",
      "",
    ].join("\n");
    return [
      {
        label: t("models.json Provider 片段"),
        displayValue: modelsConfig,
        copyValue: modelsConfig,
      },
      {
        label: t("auth.json 凭据片段"),
        displayValue: credentials(displayedToken),
        copyValue: credentials(token),
      },
      {
        label: t("settings.json 默认模型片段"),
        displayValue: defaults,
        copyValue: defaults,
      },
      {
        label: t("会话扩展片段（flowlet.ts）"),
        displayValue: sessionExtension,
        copyValue: sessionExtension,
      },
    ];
  }
  const providerConfig = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "flowlet/flowlet-pro",
    small_model: "flowlet/flowlet-flash",
    provider: {
      flowlet: {
        name: "Flowlet",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: endpoint },
        models: {
          "flowlet-pro": { name: "flowlet-pro" },
          "flowlet-flash": { name: "flowlet-flash" },
        },
      },
    },
  }, null, 2);
  if (agent === "codex") {
    // 与 Rust apply_codex 受管字段完全一致：Responses 协议、本地 Base URL、
    // 强制关闭响应存储（避免 store/previous_response_id 破坏无状态多账号路由），
    // 以及指向 Flowlet 生成的模型目录（flowlet-pro / flowlet-flash 的上下文与推理档位声明）。
    const configToml = [
      'model = "flowlet-pro"',
      'model_provider = "flowlet"',
      "disable_response_storage = true",
      'preferred_auth_method = "apikey"',
      'model_catalog_json = "~/.codex/model-catalog.flowlet.json"',
      "",
      "[model_providers.flowlet]",
      'name = "flowlet"',
      `base_url = "${endpoint}"`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n");
    const credentials = (apiKey: string) => JSON.stringify({
      OPENAI_API_KEY: apiKey,
    }, null, 2);
    return [
      {
        label: t("config.toml 配置片段"),
        displayValue: configToml,
        copyValue: configToml,
      },
      {
        label: t("auth.json 凭据片段"),
        displayValue: credentials(displayedToken),
        copyValue: credentials(token),
      },
      {
        label: t("模型目录片段（保存为 ~/.codex/model-catalog.flowlet.json）"),
        displayValue: CODEX_MODEL_CATALOG_JSON,
        copyValue: CODEX_MODEL_CATALOG_JSON,
      },
    ];
  }
  const credentials = (apiKey: string) => JSON.stringify({
    flowlet: { type: "api", key: apiKey },
  }, null, 2);
  return [
    {
      label: t("opencode.jsonc 配置片段"),
      displayValue: providerConfig,
      copyValue: providerConfig,
    },
    {
      label: t("auth.json 凭据片段"),
      displayValue: credentials(displayedToken),
      copyValue: credentials(token),
    },
    {
      label: t("权限事件插件片段（flowlet.ts）"),
      displayValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET,
      copyValue: OPENCODE_PERMISSION_PLUGIN_SNIPPET,
    },
  ];
}

function InstallationPathRow({
  executablePath,
  installDir,
  onCopy,
}: {
  executablePath: string;
  installDir: string;
  onCopy: Copy;
}) {
  const { t } = useAppPreferences();
  const [kind, setKind] = useState<"executable" | "directory">("executable");
  const label = t(kind === "executable" ? "可执行文件" : "安装目录");
  const value = kind === "executable" ? executablePath : installDir;
  return (
    <div className={styles.configRow}>
      <Select
        aria-label={t("路径类型")}
        className={styles.pathKindSelector}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
        value={kind}
        optionList={[
          { label: t("可执行文件"), value: "executable" },
          { label: t("安装目录"), value: "directory" },
        ]}
        onChange={(nextKind) => setKind(nextKind as "executable" | "directory")}
      />
      <code>{value}</code>
      <Button icon={<IconCopy />} theme="borderless" aria-label={t("复制{label}", { label })} onClick={() => void onCopy(value, t("{label} 已复制", { label }))} />
    </div>
  );
}

