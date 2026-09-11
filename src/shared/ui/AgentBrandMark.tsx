import styles from "./AgentBrandMark.module.css";

type AgentBrandMarkProps = {
  agentId: string;
  className?: string;
};

/**
 * Agent / 客户端归属 ID → 品牌样式键。
 *
 * 同一品牌的多个标识在这里归一：Codex CLI 的客户端归属 ID 是 `codex`，
 * Codex Desktop 是 `codex-desktop`，两者与 ChatGPT 桌面端共用 OpenAI 标记
 * （仓库已移除独立的 Codex 彩色图标）；DeepSeek Harness 使用 DeepSeek 标记。
 */
const AGENT_BRAND_ALIASES: Record<string, string> = {
  "chatgpt-desktop": "openai",
  codex: "openai",
  "codex-cli": "openai",
  "codex-desktop": "openai",
  "deepseek-harness": "deepseek",
};

/** `AgentBrandMark.module.css` 中已登记品牌标记的样式键。 */
const AGENT_BRAND_KEYS = new Set(["claude-code", "opencode", "pi", "hermes", "openai", "deepseek"]);

/**
 * 解析 Agent / 客户端归属 ID 的品牌样式键。
 *
 * 返回 `null` 表示该 ID 没有已登记的品牌标记，调用方应回退到首字母徽标，
 * 而不是让所有未识别客户端都渲染成 OpenAI 标记。
 */
export function agentBrandKey(agentId: string): string | null {
  const candidate = AGENT_BRAND_ALIASES[agentId] ?? agentId;
  return AGENT_BRAND_KEYS.has(candidate) ? candidate : null;
}

export function AgentBrandMark({ agentId, className }: AgentBrandMarkProps) {
  const brand = agentBrandKey(agentId) ?? "generic";
  return <span className={`${styles.mark} ${styles[brand] ?? styles.generic} ${className ?? ""}`} aria-hidden="true" />;
}
