import styles from "./AgentBrandMark.module.css";

type AgentBrandMarkProps = {
  agentId: string;
  className?: string;
};

export function AgentBrandMark({ agentId, className }: AgentBrandMarkProps) {
  const brand = agentId === "chatgpt-desktop" ? "openai" : agentId;
  return <span className={`${styles.mark} ${styles[brand] ?? styles.generic} ${className ?? ""}`} aria-hidden="true" />;
}
