import { ChannelBrandLogoView } from "@flowlet/product-ui";
import { IconLink } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { AgentBrandIcon, type AgentBrandName } from "./AgentBrandIcon";
import styles from "./EcosystemSection.module.css";

const channelIds: Record<string,string> = { LongCat: "longcat", DeepSeek: "deepseek", Kimi: "kimi", Qwen: "qwen", "Z.AI": "zhipu", OpenRouter: "openrouter" };

export function EcosystemSection() {
  const { t } = useI18n();
  return <section id="ecosystem" className={styles.section}><div className={styles.inner}>
    <header><span>{t.ecosystem.eyebrow}</span><h2>{t.ecosystem.title}</h2><p>{t.ecosystem.subtitle}</p></header>
    <div className={styles.grid}>
      <article className={styles.card}><h3>Agent</h3><p>{t.ecosystem.agents[0].detail}</p><div className={styles.chips}>{t.ecosystem.agents.map((agent) => <span key={agent.name}><AgentBrandIcon name={agent.name as AgentBrandName} /><strong>{agent.name}</strong></span>)}</div></article>
      <article className={styles.card}><h3>{t.ecosystem.channelsTitle}</h3><p>{t.ecosystem.subtitle}</p><div className={styles.chips}>{t.ecosystem.channels.map((channel) => <span key={channel}>{channelIds[channel] ? <ChannelBrandLogoView channelId={channelIds[channel]} name={channel} /> : <span className={styles.customMark}><IconLink /></span>}<strong>{channel}</strong></span>)}</div></article>
    </div>
  </div></section>;
}
