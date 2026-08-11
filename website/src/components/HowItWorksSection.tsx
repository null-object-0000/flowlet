import { ChannelBrandLogoView } from "@flowlet/product-ui";
import { useI18n } from "../i18n/I18nContext";
import styles from "./HowItWorksSection.module.css";

const AGENTS = [
  { name: "Claude Code", icon: "/icons/lobe/claudecode-color.svg" },
  { name: "Codex", icon: "/icons/lobe/codex-color.svg" },
  { name: "OpenCode", icon: "/icons/lobe/opencode.svg" },
  { name: "Pi", icon: "/icons/lobe/pi.svg" },
];
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
      <div className={styles.group}>{AGENTS.map((agent) => <div key={agent.name}><span className={styles.brandMark}><img src={agent.icon} alt="" /></span><span className={styles.brandCopy}><strong>{agent.name}</strong><small>Agent</small></span></div>)}</div>
      <div className={styles.arrow}>{t.how.localEndpoint}</div>
      <div className={styles.center}><div><img src="/flowlet-logo.png" alt="" /><strong>Flowlet</strong></div><p>{t.how.centerDesc}</p><small>127.0.0.1 · local first</small></div>
      <div className={styles.arrow}>{t.how.upstream}</div>
      <div className={styles.group}>{PROVIDERS.map((provider) => <div key={provider.name}><ChannelBrandLogoView channelId={provider.channelId} name={provider.name} /><span className={styles.brandCopy}><strong>{provider.name}</strong><small>{provider.detail}</small></span></div>)}</div>
    </div>
    <div className={styles.evidence}>{t.how.evidence.map((item,index) => <span key={item}>{String(index + 1).padStart(2,"0")} · {item}</span>)}</div>
  </div></section>;
}
