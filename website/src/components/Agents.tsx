import { Card, Tag, Typography } from "@douyinfe/semi-ui-19";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Agents.module.css";

const agentIcons: Record<string, string> = {
  "Claude Code": "/icons/lobe/claudecode.svg",
  "OpenCode CLI / Desktop": "/icons/lobe/opencode.svg",
  Pi: "/icons/lobe/pi.svg",
  "ChatGPT(Codex)/ Codex CLI": "/icons/lobe/codex.svg",
  "ChatGPT (Codex) / Codex CLI": "/icons/lobe/codex.svg",
};

export function Agents() {
  const { t } = useI18n();

  const labels = {
    detect: t.agents.table.detect,
    connect: t.agents.table.connect,
    session: t.agents.table.session,
  };

  return (
    <Section id="agents" title={t.agents.title} subtitle={t.agents.subtitle}>
      <div className={styles.grid}>
        {t.agents.rows.map((row) => {
          const icon = agentIcons[row.name] ?? "/icons/lobe/openai.svg";
          const connectEnabled = row.connect === "✅";
          return (
            <Card key={row.name} className={styles.card} bodyStyle={{ padding: 20 }}>
              <div className={styles.header}>
                <img src={icon} alt="" className={styles.icon} />
                <Typography.Title heading={4} className={styles.name}>
                  {row.name}
                </Typography.Title>
              </div>
              <div className={styles.tags}>
                <Tag color="blue" type="light" size="small">
                  {labels.detect}: {row.detect}
                </Tag>
                <Tag color={connectEnabled ? "green" : "orange"} type="light" size="small">
                  {labels.connect}: {row.connect}
                </Tag>
                <Tag color="blue" type="light" size="small">
                  {labels.session}: {row.session}
                </Tag>
              </div>
            </Card>
          );
        })}
      </div>
      <Typography.Paragraph type="tertiary" size="small" className={styles.note}>
        {t.agents.note}
      </Typography.Paragraph>
    </Section>
  );
}
