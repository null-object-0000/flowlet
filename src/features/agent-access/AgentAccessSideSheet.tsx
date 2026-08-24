import { useEffect, useMemo, useState } from "react";
import { Button, Collapsible, Select, SideSheet, Switch, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconCopy, IconRefresh } from "@douyinfe/semi-icons";
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
  AgentSurface,
} from "../../domains/agent/types";
import { agentPlugin, type AgentPluginId } from "../../domains/pluginRegistry";
import { agentAccessAdapter, type AgentConfigControl } from "./agentAccessAdapters";
import { McpServersPanel } from "./McpServersPanel";

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
  runtimeBusy?: boolean;
  runtimeError?: string;
  onStartRuntime: () => Promise<void>;
  onStopRuntime: () => Promise<void>;
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
  runtimeBusy = false,
  runtimeError,
  onStartRuntime,
  onStopRuntime,
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
  /** 当前激活 Tab：Agent Surface（cli/desktop/web）或 DSH 专属的 "mcp"。 */
  const [surface, setSurface] = useState<AgentSurface | "mcp">("cli");
  /** 仅 DeepSeek Harness 提供受管 MCP 服务器 Tab。 */
  const supportsMcp = agent === "deepseek-harness";

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
  // 稳定引用：避免每次渲染生成新数组导致 MCP 面板草稿被意外重置。
  const mcpServers = useMemo(() => globalConfig?.mcp_servers ?? [], [globalConfig]);

  useEffect(() => {
    setSurface(meta.surfaces[0]);
  }, [visible, agent, meta.surfaces]);

  const surfaceInstallations = environment?.installations.filter(
    (installation) => (installation.surface || "cli") === surface,
  );
  // npm latest 对应可分发运行时：传统 Agent 取 CLI，DSH 取 Web；Desktop 不参与比较。
  const packageSurface: AgentSurface = meta.surfaces.includes("cli") ? "cli" : "web";
  const packageInstalled = environment?.installations.some((item) => (item.surface ?? "cli") === packageSurface) ?? false;
  const installedVersion = packageSurface === "cli"
    ? cliInstalledVersion(environment)
    : environment?.installations.find((item) => item.surface === packageSurface)?.version ?? null;
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
          onChange={(key) => setSurface(key as AgentSurface | "mcp")}
        >
          {meta.surfaces.includes("cli") ? <Tabs.TabPane tab={t("{name} CLI 接入", { name })} itemKey="cli" /> : null}
          {meta.surfaces.includes("desktop") ? (
            <Tabs.TabPane tab={t("{name} Desktop 接入", { name })} itemKey="desktop" />
          ) : null}
          {meta.surfaces.includes("web") ? (
            <Tabs.TabPane tab={t("{name} Web 接入", { name })} itemKey="web" />
          ) : null}
          {supportsMcp ? <Tabs.TabPane tab={t("MCP 服务器")} itemKey="mcp" /> : null}
        </Tabs>
      }
      headerStyle={{ paddingBottom: 0 }}
      width={DETAIL_SHEET_WIDTH}
      footer={null}
      bodyStyle={{ padding: 0 }}
      onCancel={onClose}
    >
      <div className={styles.body}>
        {surface === "mcp" ? (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <Title heading={5}>{t("MCP 服务器")}</Title>
                <Text type="tertiary" size="small">
                  {t("管理 DeepSeek Harness 桥接的外部 MCP 服务器；工具会注册为 mcp__服务器名__工具名。")}
                </Text>
              </div>
            </div>
            {globalConfigLoading && !globalConfig ? (
              <Text type="tertiary" size="small">{t("读取全局配置中…")}</Text>
            ) : (
              <McpServersPanel
                busy={globalConfigBusy}
                disabled={globalConfig?.state === "invalid" || !clientToken}
                servers={mcpServers}
                onSave={(mcps) => {
                  void onApplyGlobalConfig({ ...adapter.applyOptions(adapterContext), mcpServers: mcps });
                }}
              />
            )}
          </section>
        ) : (
        <>
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
                    ? t("未检测到 {surface} 安装。", { surface: t(surface === "desktop" ? "Desktop" : surface === "web" ? "Web" : "CLI") })
                    : t(meta.notInstalledText)}
                </Text>
                <a className={styles.officialLink} href={meta.officialUrl} target="_blank" rel="noreferrer">
                  {t("前往官网安装")}
                </a>
              </div>
            ) : null}
            {/* npm 包版本只在对应的 CLI / Web 标签页展示，Desktop 不参与。 */}
            {!environmentError && !environmentLoading && environment?.installed && surface === packageSurface && packageInstalled ? (
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
            {surface === "web" && environment?.runtime_running != null && surfaceInstallations?.length ? (
              <AgentRuntimeControl
                environment={environment}
                busy={runtimeBusy}
                error={runtimeError}
                onStart={onStartRuntime}
                onStop={onStopRuntime}
              />
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
                  surface={installation.surface ?? "cli"}
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
                  agentName={meta.name}
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
                {meta.supportsManagedConfig ? <div className={styles.configActions}>
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
                </div> : <Text className={styles.configNotice} type="tertiary">{t("当前版本请使用下方片段手动配置；")}{t(meta.restartTip)}</Text>}
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
        </>
        )}
      </div>
    </SideSheet>
  );
}

function AgentRuntimeControl({
  environment,
  busy,
  error,
  onStart,
  onStop,
}: {
  environment: AgentEnvironmentReport;
  busy: boolean;
  error?: string;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const { t } = useAppPreferences();
  const running = environment.runtime_running === true;
  const managed = environment.runtime_managed === true;
  return (
    <div className={styles.runtimePanel}>
      <div className={styles.runtimeSummary}>
        <span className={`${styles.runtimeDot} ${running ? styles.runtimeDotRunning : ""}`} />
        <div>
          <strong>{t("DSH Web 服务")}</strong>
          <small>
            {t(running ? managed ? "由 Flowlet 启动并管理" : "已在 Flowlet 外部运行" : "当前未运行")}
          </small>
        </div>
        <Tag color={running ? "green" : "grey"}>{t(running ? "运行中" : "已停止")}</Tag>
      </div>
      <div className={styles.runtimeCommandRow}>
        <span>{t("启动命令")}</span>
        <code>{environment.runtime_command || "-"}</code>
      </div>
      <div className={styles.runtimeActions}>
        {running ? (
          <>
            <a className={styles.officialLink} href="http://127.0.0.1:3080" target="_blank" rel="noreferrer">
              {t("打开 DSH Web")}
            </a>
            <Button
              type="danger"
              theme="light"
              loading={busy}
              disabled={!managed}
              onClick={() => void onStop()}
            >
              {t(managed ? "停止服务" : "外部进程不可停止")}
            </Button>
          </>
        ) : (
          <Button
            type="primary"
            theme="solid"
            loading={busy}
            disabled={!environment.runtime_command}
            onClick={() => void onStart()}
          >
            {t("启动服务")}
          </Button>
        )}
      </div>
      {error ? <Text className={styles.runtimeError} type="danger">{error}</Text> : null}
    </div>
  );
}

function installMethodLabel(method: AgentInstallMethod, t: (source: string) => string) {
  const labels: Record<AgentInstallMethod, string> = {
    native: "原生安装",
    winget: "WinGet",
    npm: "npm 全局安装",
    npx: "npx 缓存",
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
  agentName,
  busy,
  disabled,
  onApplyGlobalConfig,
}: {
  controls: AgentConfigControl[];
  /** 当前 Agent 展示名，用于「需重启」标签与提示中的重启对象（Claude Code / OpenCode / DSH…）。 */
  agentName: string;
  busy: boolean;
  disabled: boolean;
  onApplyGlobalConfig: (options?: AgentGlobalConfigOptions) => Promise<void>;
}) {
  const { t } = useAppPreferences();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (controls.length === 0) return null;
  const rows = controls.map((control) => (
    <div className={styles.capabilityRow} key={control.id}>
      <div className={styles.capabilityContent}>
        <div className={styles.capabilityTitle}>
          <strong>{control.label}</strong>
          <Tag size="small" color={control.checked ? "green" : "grey"}>{t(control.checked ? "已启用" : "未启用")}</Tag>
          {control.requiresRestart ? <Tag size="small">{t("需重启 {name}", { name: agentName })}</Tag> : null}
        </div>
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
  const enabledCount = controls.filter((control) => control.checked).length;
  return (
    <div className={styles.advancedSection}>
      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={advancedOpen}
        aria-label={t("高级配置（可选能力）")}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <span className={styles.advancedTitle}>
          <strong>{t("高级配置")}</strong>
          <small>{t("可选增强能力，不影响基础 Provider 接入")}</small>
        </span>
        <span className={styles.advancedSummary}>
          <Tag color={enabledCount > 0 ? "blue" : "grey"} size="small">
            {enabledCount > 0 ? t("已启用 {count} 项", { count: enabledCount }) : t("均未启用")}
          </Tag>
          <IconChevronDown size="small" className={advancedOpen ? styles.chevronExpanded : undefined} />
        </span>
      </button>
      <Collapsible isOpen={advancedOpen} motion={false} keepDOM lazyRender>
        <div className={styles.capabilityList}>{rows}</div>
        <small className={styles.advancedNote}>{t("开关会立即写入配置；标记为需重启的能力将在下次启动 {name} 后生效。", { name: agentName })}</small>
      </Collapsible>
    </div>
  );
}

function InstallationPathRow({
  surface,
  executablePath,
  installDir,
  onCopy,
}: {
  surface: AgentSurface;
  executablePath: string;
  installDir: string;
  onCopy: Copy;
}) {
  const { t } = useAppPreferences();
  const [kind, setKind] = useState<"executable" | "directory">("executable");
  const label = t(kind === "executable" ? (surface === "web" ? "启动入口" : "可执行文件") : (surface === "web" ? "Harness 目录" : "安装目录"));
  const value = kind === "executable" ? executablePath : installDir;
  return (
    <div className={styles.configRow}>
      <Select
        aria-label={t("路径类型")}
        className={styles.pathKindSelector}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
        value={kind}
        optionList={[
          { label: t(surface === "web" ? "启动入口" : "可执行文件"), value: "executable" },
          { label: t(surface === "web" ? "Harness 目录" : "安装目录"), value: "directory" },
        ]}
        onChange={(nextKind) => setKind(nextKind as "executable" | "directory")}
      />
      <code>{value}</code>
      <Button icon={<IconCopy />} theme="borderless" aria-label={t("复制{label}", { label })} onClick={() => void onCopy(value, t("{label} 已复制", { label }))} />
    </div>
  );
}
