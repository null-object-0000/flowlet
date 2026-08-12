import { ChannelBrandLogoView } from "@flowlet/product-ui";
import { useI18n } from "../i18n/I18nContext";
import { AgentBrandIcon, type AgentBrandName } from "./AgentBrandIcon";
import styles from "./HowItWorksSection.module.css";

const AGENTS: AgentBrandName[] = ["Claude Code", "Codex", "OpenCode", "Pi"];
const PROVIDERS = [
  { name: "DeepSeek", detail: "2 accounts", channelId: "deepseek" },
  { name: "Kimi", detail: "1 account", channelId: "kimi" },
  { name: "Qwen", detail: "2 accounts", channelId: "qwen" },
  { name: "OpenRouter", detail: "custom", channelId: "openrouter" },
];

export function HowItWorksSection() {
  const { t } = useI18n();
  return <section id="how" className={styles.section}><div className={styles.inner}>
    <header><span>{t.how.eyebrow}</span><h2>{t.how.title}</h2><p>{t.how.subtitle}</p></header>
    <div className={styles.pipeline}>
      <div className={styles.group}>{AGENTS.map((agent) => <div key={agent}><span className={styles.brandMark}><AgentBrandIcon name={agent} /></span><span className={styles.brandCopy}><strong>{agent}</strong><small>Agent</small></span></div>)}</div>
      <div className={styles.arrow}><span>{t.how.localEndpoint}</span></div>
      <div className={styles.center}><div><img src="/flowlet-logo.png" alt="" /><strong>Flowlet</strong></div><p>{t.how.centerDesc}</p><small>127.0.0.1 · local first</small></div>
      <div className={styles.arrow}><span>{t.how.upstream}</span></div>
      <div className={styles.group}>{PROVIDERS.map((provider) => <div key={provider.name}><ChannelBrandLogoView channelId={provider.channelId} name={provider.name} /><span className={styles.brandCopy}><strong>{provider.name}</strong><small>{provider.detail}</small></span></div>)}</div>
    </div>
    <div className={styles.evidence}>{t.how.evidence.map((item,index) => <span key={item}>{String(index + 1).padStart(2,"0")} · {item}</span>)}</div>
  </div></section>;
}
