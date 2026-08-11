import styles from "./AgentBrandIcon.module.css";

const AGENT_ICONS = {
  "Claude Code": { src: "/icons/lobe/claudecode-color.svg", monochrome: false },
  Codex: { src: "/icons/lobe/codex-color.svg", monochrome: false },
  OpenCode: { src: "/icons/lobe/opencode.svg", monochrome: true },
  Pi: { src: "/icons/lobe/pi.svg", monochrome: true },
} as const;

export type AgentBrandName = keyof typeof AGENT_ICONS;

export function AgentBrandIcon({ name, className }: { name: AgentBrandName; className?: string }) {
  const icon = AGENT_ICONS[name];
  return <img src={icon.src} alt="" aria-hidden="true" className={`${styles.icon} ${icon.monochrome ? styles.monochrome : ""} ${className ?? ""}`} />;
}
