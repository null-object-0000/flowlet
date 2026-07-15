import { Button, SideSheet, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy } from "@douyinfe/semi-icons";
import styles from "./AgentAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Text, Title } = Typography;

export type AgentKind = "claude-code" | "opencode";
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  agent: AgentKind | null;
  baseUrl: string;
  clientToken?: string | null;
  onClose: () => void;
  onCopy: Copy;
};

export function AgentAccessSideSheet({ agent, baseUrl, clientToken, onClose, onCopy }: Props) {
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
