import { Typography } from "@douyinfe/semi-ui-19";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import styles from "./OverviewAgentAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

const AGENTS: Array<{
  name: string;
  description: string;
  icon: React.ReactNode;
  iconClassName: string;
}> = [
  {
    name: "Claude Code CLI",
    description: "命令行接入",
    icon: <span className={`${styles.brandIcon} ${styles.claudeCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.claudeIcon,
  },
  {
    name: "OpenCode CLI",
    description: "命令行接入",
    icon: <span className={`${styles.brandIcon} ${styles.openCodeMark}`} aria-hidden="true" />,
    iconClassName: styles.openCodeIcon,
  },
  {
    name: "Codex Desktop",
    description: "客户端接入",
    icon: <span className={`${styles.brandIcon} ${styles.codexMark}`} aria-hidden="true" />,
    iconClassName: styles.codexIcon,
  },
];

export function OverviewAgentAccessCard() {
  const { t } = useAppPreferences();

  return (
    <OverviewModuleCard title={t("AI Agent 接入")}>
      <Text type="tertiary" size="small">{t("选择适合的 Agent 并查看接入方案")}</Text>
      <div className={styles.grid}>
        {AGENTS.map(({ name, description, icon, iconClassName }) => (
          <button
            key={name}
            type="button"
            className={styles.agentCard}
            aria-label={t("{name} 即将支持", { name })}
            disabled
          >
            <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
            <span className={styles.agentText}><strong>{name}</strong><small>{t(description)}</small></span>
            <span className={styles.support}>{t("即将支持")}</span>
          </button>
        ))}
      </div>
    </OverviewModuleCard>
  );
}
