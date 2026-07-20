import { useEffect, useMemo, useState } from "react";
import { Button, Select, SideSheet, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import styles from "./AgentAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import type {
  AgentEnvironmentReport,
  AgentGlobalConfigReport,
  AgentGlobalConfigState,
  AgentInstallMethod,
} from "../../domains/agent/types";

const { Text, Title } = Typography;
const MASKED_TOKEN = "••••••••••••••••••••";

export type AgentKind = "claude-code" | "opencode";
type Copy = (value: string, message: string) => Promise<void>;

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
  onApplyGlobalConfig: () => Promise<void>;
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

  const isClaude = agent === "claude-code";
  const name = isClaude ? "Claude Code" : "OpenCode";
  const endpoint = `${baseUrl}${isClaude ? "/anthropic" : "/v1"}`;
  const token = clientToken || "<Client Token>";
  const displayedToken = clientToken ? MASKED_TOKEN : token;
  const manualSnippets = useMemo(
    () => buildManualSnippets(isClaude, endpoint, token, displayedToken, t),
    [displayedToken, endpoint, isClaude, t, token],
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
          <Tabs.TabPane tab={t("{name} Desktop 接入", { name })} itemKey="desktop" disabled={isClaude} />
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
                  {t(isClaude ? "识别 Claude Code 的安装位置、版本和安装方式" : "识别 OpenCode CLI 与 Desktop 的安装位置和版本")}
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
                {t(isClaude ? "未检测到 Claude Code。Flowlet 会检查 PATH 和官方常见安装位置。" : "未检测到 OpenCode CLI 或 Desktop。Flowlet 会检查 PATH 和常见安装位置。")}
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
                  {t(isClaude ? "配置后可从任意终端或 IDE 启动 Claude Code" : "OpenCode CLI 与 Desktop 共用此全局配置")}
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
                {!isClaude && globalConfig.credentials_path ? (
                  <ConfigRow
                    label={t("凭据文件")}
                    value={globalConfig.credentials_path}
                    onCopy={() => onCopy(globalConfig.credentials_path || "", t("{label} 已复制", { label: t("凭据文件") }))}
                  />
                ) : null}
                {globalConfig.base_url ? <StatusRow label="Base URL" value={globalConfig.base_url} /> : null}
                <StatusRow label="Client Token" value={t(globalConfig.auth_token_configured ? "已配置（内容已隐藏）" : "未配置")} />
                <StatusRow label={t("主模型")} value={globalConfig.primary_model || "-"} />
                <StatusRow label={t("快速模型")} value={globalConfig.fast_model || "-"} />
                {isClaude ? <StatusRow label={t("子 Agent 模型")} value={globalConfig.subagent_model || "-"} /> : null}
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
                    onClick={() => void onApplyGlobalConfig()}
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
            {t(isClaude ? "以下内容与一键写入的 Claude Code 全局配置一致" : "OpenCode 的 Provider 配置与凭据文件需要分别设置")}
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
            <li>{t(isClaude ? "修改全局配置后请重新启动 Claude Code。" : "修改全局配置后请重新启动 OpenCode CLI 与 Desktop。")}</li>
            {!clientToken ? <li>{t("当前未配置默认 Client Token，请先在客户端设置中完成配置。")}</li> : null}
          </ul>
        </section>
      </div>
    </SideSheet>
  );
}

function globalConfigTag(state: AgentGlobalConfigState): { label: string; color: "green" | "orange" | "red" | "grey" } {
  const values: Record<AgentGlobalConfigState, { label: string; color: "green" | "orange" | "red" | "grey" }> = {
    not_configured: { label: "未配置", color: "grey" },
    flowlet: { label: "已接入 Flowlet", color: "green" },
    other_gateway: { label: "已配置其他网关", color: "orange" },
    partial: { label: "配置不完整", color: "orange" },
    invalid: { label: "配置文件无效", color: "red" },
  };
  return values[state];
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
  const name = agent === "claude-code" ? "Claude Code" : surface === "desktop" ? "OpenCode Desktop" : "OpenCode CLI";
  return version ? `${name} ${version}` : t(`${name} 安装`);
}

function buildManualSnippets(
  isClaude: boolean,
  endpoint: string,
  token: string,
  displayedToken: string,
  t: (source: string) => string,
) {
  if (isClaude) {
    const value = (authToken: string) => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: "flowlet-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "flowlet-pro",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "flowlet-pro",
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
  ];
}

function ConfigRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => Promise<void> }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.configRow}>
      <Text type="tertiary" size="small">{label}</Text>
      <code>{value}</code>
      <Button icon={<IconCopy />} theme="borderless" aria-label={t("复制{label}", { label })} onClick={() => void onCopy()} />
    </div>
  );
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

function StatusRow({ label, value }: { label: string; value: string }) {
  return <div className={styles.statusRow}><Text type="tertiary" size="small">{label}</Text><code>{value}</code></div>;
}
