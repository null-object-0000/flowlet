import { useEffect, useMemo, useState } from "react";
import { Button, Select, SideSheet, Switch, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import styles from "./AgentAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { ConfigRow, StatusRow, globalConfigTag } from "./globalConfigPresentation";
import { cliInstalledVersion, isNewerVersion } from "../../domains/agent/versions";
import type {
  AgentEnvironmentReport,
  AgentGlobalConfigOptions,
  AgentGlobalConfigReport,
  AgentInstallMethod,
} from "../../domains/agent/types";
import { agentPlugin, type AgentPluginId } from "../../domains/pluginRegistry";
import { agentAccessAdapter, type AgentConfigControl } from "./agentAccessAdapters";

const { Text, Title } = Typography;
const MASKED_TOKEN = "••••••••••••••••••••";
export type AgentKind = AgentPluginId;
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
  latestVersion?: string | null;
  latestVersionLoading?: boolean;
  latestVersionError?: string;
  onRefreshLatestVersion: () => void;
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
  latestVersion,
  latestVersionLoading = false,
  latestVersionError,
  onRefreshLatestVersion,
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

  const meta = agentPlugin(agent);
  const adapter = agentAccessAdapter(meta.globalConfigAdapterId);
  const name = meta.name;
  const endpoint = `${baseUrl}${meta.endpointSuffix}`;
  const token = clientToken || "<Client Token>";
  const displayedToken = clientToken ? MASKED_TOKEN : token;
  const adapterContext = useMemo(() => ({ endpoint, token, displayedToken, globalConfig, t }), [displayedToken, endpoint, globalConfig, t, token]);
  const manualSnippets = useMemo(
    () => adapter.manualSnippets(adapterContext),
    [adapter, adapterContext],
  );
  const configStatuses = adapter.configStatuses(adapterContext);
  const configControls = adapter.configControls(adapterContext);

  useEffect(() => {
    setSurface("cli");
  }, [visible, agent]);

  const surfaceInstallations = environment?.installations.filter(
    (installation) => (installation.surface || "cli") === surface,
  );
  // 版本更新提示只针对 CLI 包（npm latest 对应 CLI 版本），桌面应用不参与比较。
  const cliInstalled = environment?.installations.some((item) => (item.surface ?? "cli") === "cli") ?? false;
  const installedVersion = cliInstalledVersion(environment);
  const newer = isNewerVersion(latestVersion, installedVersion);

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
          {meta.surfaces.includes("desktop") ? (
            <Tabs.TabPane tab={t("{name} Desktop 接入", { name })} itemKey="desktop" />
          ) : null}
        </Tabs>
      }
      headerStyle={{ paddingBottom: 0 }}
      width={DETAIL_SHEET_WIDTH}
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
            {/* 未安装引导：只要当前标签页（CLI/Desktop）没有任何安装就展示，含官网安装入口。
                不能只用 environment.installed 判断——Codex 探测到 ChatGPT Desktop 时整体
                installed 为 true，但 CLI 标签页仍可能没有 CLI，必须照常给出安装引导。 */}
            {!environmentError && !environmentLoading && !surfaceInstallations?.length ? (
              <div className={styles.installGuide}>
                <Text type="tertiary" size="small">
                  {environment?.installed
                    ? t("未检测到 {surface} 安装。", { surface: t(surface === "desktop" ? "Desktop" : "CLI") })
                    : t(meta.notInstalledText)}
                </Text>
                <a className={styles.officialLink} href={meta.officialUrl} target="_blank" rel="noreferrer">
                  {t("前往官网安装")}
                </a>
              </div>
            ) : null}
            {/* 版本更新提示仅适用于 CLI：npm latest 是 CLI 包版本，桌面标签页不展示。 */}
            {!environmentError && !environmentLoading && environment?.installed && surface === "cli" && cliInstalled ? (
              <div className={styles.versionBlock}>
                {newer ? (
                  <div className={styles.updateNotice}>
                    <span>
                      {t("检测到新版本：{installed} → {latest}", {
                        installed: installedVersion || "-",
                        latest: latestVersion || "-",
                      })}
                    </span>
                    <a className={styles.officialLink} href={meta.updateUrl} target="_blank" rel="noreferrer">
                      {t("前往官网查看更新说明")}
                    </a>
                  </div>
                ) : latestVersionError ? (
                  <div className={styles.versionErrorRow}>
                    <Text className={styles.versionMuted} type="tertiary" size="small">
                      {t("版本检查失败：{message}", { message: latestVersionError })}
                    </Text>
                    <Button size="small" theme="borderless" onClick={onRefreshLatestVersion}>
                      {t("重新检查")}
                    </Button>
                  </div>
                ) : latestVersion && !latestVersionLoading ? (
                  <Text className={styles.versionMuted} type="tertiary" size="small">
                    {t("已是最新版本")}
                  </Text>
                ) : null}
              </div>
            ) : null}
            {surfaceInstallations?.map((installation, index) => {
              const duplicateSurface = surfaceInstallations
                .slice(0, index)
                .some((candidate) => (candidate.surface || "cli") === (installation.surface || "cli"));
              return (
              <div className={styles.installation} key={installation.executable_path}>
                <div className={styles.installationHeader}>
                  <strong>{installationTitle(adapter.installationName(installation.surface), installation.version, t)}</strong>
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
                {configStatuses.map((status) => <StatusRow key={status.label} label={status.label} value={status.value} />)}
                {meta.showsFastModel ? <StatusRow label={t("快速模型")} value={globalConfig.fast_model || "-"} /> : null}
                {meta.showsSubagentModel ? <StatusRow label={t("子 Agent 模型")} value={globalConfig.subagent_model || "-"} /> : null}
                <AgentConfigControls
                  controls={configControls}
                  busy={globalConfigBusy}
                  disabled={globalConfig.state === "invalid" || !clientToken}
                  onApplyGlobalConfig={onApplyGlobalConfig}
                />
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
                    onClick={() => void onApplyGlobalConfig(adapter.applyOptions(adapterContext))}
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
  name: string,
  version: string | null | undefined,
  t: (source: string) => string,
) {
  return version ? `${name} ${version}` : t(`${name} 安装`);
}

function AgentConfigControls({
  controls,
  busy,
  disabled,
  onApplyGlobalConfig,
}: {
  controls: AgentConfigControl[];
  busy: boolean;
  disabled: boolean;
  onApplyGlobalConfig: (options?: AgentGlobalConfigOptions) => Promise<void>;
}) {
  const rows = controls.map((control) => (
    <div className={styles.longContextRow} key={control.id}>
      <div>
        <strong>{control.label}</strong>
        {control.descriptions.map((description) => <small key={description}>{description}</small>)}
      </div>
      <Switch
        checked={control.checked}
        disabled={busy || disabled}
        loading={busy}
        aria-label={control.label}
        onChange={(checked) => void onApplyGlobalConfig(control.applyOptions(checked))}
      />
    </div>
  ));
  return controls.length > 1 ? <div className={styles.longContextGroup}>{rows}</div> : rows;
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
