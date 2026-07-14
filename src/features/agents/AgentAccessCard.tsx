import React from "react";
import { Text, UnstyledButton } from "@mantine/core";
import { IconBrandOpenai, IconRobot } from "@tabler/icons-react";
import { Panel, PanelHeader } from "../../components/ui";
import styles from "./AgentAccessCard.module.css";

type AgentAccessCardProps = {
  baseUrl: string;
  onCopy: (text: string, done: string) => Promise<void>;
};

const AGENT_CARDS: Array<{ name: string; desc: string; endpoint: string }> = [
  { name: "Claude Code", desc: "官方 CLI 工具", endpoint: "/anthropic" },
  { name: "Cline", desc: "VS Code 扩展", endpoint: "/v1" },
  { name: "OpenCode", desc: "智能编码助手", endpoint: "/v1" },
  { name: "Continue", desc: "开源 AI 助手", endpoint: "/v1" },
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
            <span>{card.name === "Claude Code" ? <IconBrandOpenai size={28} /> : <IconRobot size={28} />}</span>
            <strong>{card.name}</strong>
            <small>{card.desc}</small>
          </UnstyledButton>
        ))}
      </div>
    </Panel>
  );
}
