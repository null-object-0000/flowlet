import { useState } from "react";
import { Toast, Typography } from "@douyinfe/semi-ui-19";
import ClaudeCodeLogo from "@lobehub/icons/es/ClaudeCode/components/Mono";
import OpenCodeLogo from "@lobehub/icons/es/OpenCode/components/Mono";
import CursorLogo from "@lobehub/icons/es/Cursor/components/Mono";
import { IconChevronRight } from "@douyinfe/semi-icons";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { AgentAccessSideSheet, type AgentKind } from "./AgentAccessSideSheet";
import styles from "./OverviewAgentAccessCard.module.css";

const { Text } = Typography;

const AGENTS: Array<{
  kind: AgentKind | null;
  name: string;
  description: string;
  icon: React.ReactNode;
  iconClassName: string;
  supported: boolean;
}> = [
  {
    kind: "claude-code",
    name: "Claude Code CLI",
    description: "命令行接入",
    icon: <ClaudeCodeLogo size={22} aria-hidden="true" />,
    iconClassName: styles.claudeIcon,
    supported: true,
  },
  {
    kind: "opencode",
    name: "OpenCode CLI",
    description: "命令行接入",
    icon: <OpenCodeLogo size={22} aria-hidden="true" />,
    iconClassName: styles.openCodeIcon,
    supported: true,
  },
  {
    kind: null,
    name: "Cursor",
    description: "客户端接入",
    icon: <CursorLogo size={21} aria-hidden="true" />,
    iconClassName: styles.cursorIcon,
    supported: false,
  },
];

type Props = {
  baseUrl: string;
  clientToken?: string | null;
};

export function OverviewAgentAccessCard({ baseUrl, clientToken }: Props) {
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | null>(null);

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <>
      <OverviewModuleCard title="AI Agent 接入">
        <Text type="tertiary" size="small">选择适合的 Agent 并查看接入方案</Text>
        <div className={styles.grid}>
          {AGENTS.map(({ kind, name, description, icon, iconClassName, supported }) => (
            <button
              key={name}
              type="button"
              className={styles.agentCard}
              aria-label={`配置 ${name}`}
              onClick={() => kind && setSelectedAgent(kind)}
            >
              <span className={`${styles.icon} ${iconClassName}`}>{icon}</span>
              <span className={styles.agentText}><strong>{name}</strong><small>{description}</small></span>
              <span className={`${styles.support} ${supported ? styles.supported : ""}`}>{supported ? "已支持" : "即将支持"}</span>
              <IconChevronRight className={styles.chevron} />
            </button>
          ))}
        </div>
      </OverviewModuleCard>

      <AgentAccessSideSheet
        agent={selectedAgent}
        baseUrl={baseUrl}
        clientToken={clientToken}
        onClose={() => setSelectedAgent(null)}
        onCopy={copy}
      />
    </>
  );
}
