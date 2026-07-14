import React from "react";
import { Text, UnstyledButton } from "@mantine/core";
import { ClaudeCode, OpenCode } from "@lobehub/icons";
import { Panel, PanelHeader } from "../../components/ui";
import styles from "./AgentAccessCard.module.css";

type AgentAccessCardProps = {
  baseUrl: string;
  onCopy: (text: string, done: string) => Promise<void>;
};

const AGENT_CARDS: Array<{ name: string; desc: string; endpoint: string; avatar: React.ComponentType<{ size: number }> }> = [
  { name: "Claude Code CLI", desc: "命令行接入", endpoint: "/anthropic", avatar: ClaudeCode.Avatar },
  { name: "OpenCode CLI", desc: "命令行接入", endpoint: "/v1", avatar: OpenCode.Avatar },
];

export function AgentAccessCard({ baseUrl, onCopy }: AgentAccessCardProps) {
  return (
    <Panel className={`overview-section-card ${styles.agents}`}>
      <PanelHeader>
        <div>
          <h3>AI Agent 接入</h3>
          <Text size="sm" c="dimmed">选择接入的 Agent 并复制配置</Text>
        </div>
      </PanelHeader>
      <div className={styles.grid}>
        {AGENT_CARDS.map((card) => (
          <UnstyledButton
            type="button"
            className={styles.card}
            key={card.name}
            onClick={() => void onCopy(`${baseUrl}${card.endpoint}`, `${card.name} 接入地址已复制`)}
          >
            <span><card.avatar size={28} /></span>
            <strong>{card.name}</strong>
            <small>{card.desc}</small>
          </UnstyledButton>
        ))}
      </div>
    </Panel>
  );
}
