import { Button, SideSheet, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import styles from "./AgentAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import type { AgentEnvironmentReport, AgentInstallMethod } from "../../domains/agent/types";

const { Paragraph, Text, Title } = Typography;

export type AgentKind = "claude-code" | "opencode";
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  agent: AgentKind | null;
  baseUrl: string;
  clientToken?: string | null;
  environment?: AgentEnvironmentReport;
  environmentLoading?: boolean;
  environmentError?: string;
  onRefreshEnvironment: () => void;
  onClose: () => void;
  onCopy: Copy;
};

export function AgentAccessSideSheet({
  agent,
  baseUrl,
  clientToken,
  environment,
  environmentLoading = false,
  environmentError,
  onRefreshEnvironment,
  onClose,
  onCopy,
}: Props) {
  const { t } = useAppPreferences();
  if (!agent) return null;

  const isClaude = agent === "claude-code";
  const name = isClaude ? "Claude Code CLI" : "OpenCode CLI";
  const protocol = isClaude ? "Anthropic-compatible" : "OpenAI-compatible";
  const endpoint = `${baseUrl}${isClaude ? "/anthropic" : "/v1"}`;
  const token = clientToken || "<Client Token>";
  const config = isClaude
    ? `export ANTHROPIC_BASE_URL=${endpoint}\nexport ANTHROPIC_AUTH_TOKEN=${token}`
    : `OPENAI_BASE_URL=${endpoint}\nOPENAI_API_KEY=${token}`;

  return (
    <SideSheet
      visible
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={t("{name} 接入", { name })}
      width="min(680px, 92vw)"
      footer={null}
      bodyStyle={{ padding: 0 }}
      onCancel={onClose}
    >
      <div className={styles.body}>
        <section className={styles.intro}>
          <div className={styles.titleRow}>
            <Title heading={4} style={{ margin: 0 }}>{name}</Title>
            <Tag color="blue">{protocol}</Tag>
          </div>
          <Paragraph type="tertiary">
            {isClaude
              ? t("通过 Anthropic-compatible 协议将 Claude Code 接入 Flowlet。")
              : t("通过 OpenAI-compatible 协议将 OpenCode 接入 Flowlet。")}
          </Paragraph>
        </section>

        {isClaude ? (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <Title heading={5}>{t("本机环境")}</Title>
                <Text type="tertiary" size="small">{t("识别 Claude Code 的安装位置、版本和安装方式")}</Text>
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
                {t("未检测到 Claude Code。Flowlet 会检查 PATH 和官方常见安装位置。")}
              </Text>
            ) : null}
            {environment?.installations.map((installation, index) => (
              <div className={styles.installation} key={installation.executable_path}>
                <div className={styles.installationHeader}>
                  <strong>{installation.version ? `Claude Code ${installation.version}` : t("Claude Code 安装")}</strong>
                  <span className={styles.installationTags}>
                    {environment.primary?.executable_path === installation.executable_path ? <Tag color="blue">{t("当前使用")}</Tag> : null}
                    <Tag>{installMethodLabel(installation.install_method, t)}</Tag>
                    {index > 0 ? <Tag color="orange">{t("额外安装")}</Tag> : null}
                  </span>
                </div>
                <ConfigRow
                  label={t("可执行文件")}
                  value={installation.executable_path}
                  onCopy={() => onCopy(installation.executable_path, t("{label} 已复制", { label: t("可执行文件") }))}
                />
                <ConfigRow
                  label={t("安装目录")}
                  value={installation.install_dir}
                  onCopy={() => onCopy(installation.install_dir, t("{label} 已复制", { label: t("安装目录") }))}
                />
                {installation.error ? <Text className={styles.installationError} type="warning">{installation.error}</Text> : null}
              </div>
            ))}
          </section>
        ) : null}

        <section className={styles.section}>
          <Title heading={5}>{t("接入参数")}</Title>
          <ConfigRow label="Base URL" value={endpoint} onCopy={() => onCopy(endpoint, t("{label} 已复制", { label: "Base URL" }))} />
          <ConfigRow
            label="Client Token"
            value={token}
            onCopy={() => onCopy(token, t("{label} 已复制", { label: "Client Token" }))}
          />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("完整配置")}</Title>
              <Text type="tertiary" size="small">
                {t(isClaude ? "在启动 Claude Code 前设置以下环境变量" : "在 OpenCode 的运行环境中设置以下变量")}
              </Text>
            </div>
            <Button
              aria-label={t("复制完整配置")}
              icon={<IconCopy />}
              theme="light"
              type="primary"
              onClick={() => void onCopy(config, t("{name} 完整配置已复制", { name }))}
            >
              {t("复制完整配置")}
            </Button>
          </div>
          <pre className={styles.codeBlock}><code>{config}</code></pre>
        </section>

        <section className={styles.tip}>
          <Title heading={5}>{t("使用提示")}</Title>
          <ul>
            <li>{t("Client Token 用于访问本地 Flowlet，不是上游渠道的 API Key。")}</li>
            <li>{t("修改环境变量后请重新启动对应的 Agent 进程。")}</li>
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
    legacy_npm: "旧版 npm 安装",
    homebrew: "Homebrew",
    system_package: "系统包管理器",
    unknown: "未知方式",
  };
  return t(labels[method]);
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
