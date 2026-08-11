import { ChannelBrandLogoView } from "@flowlet/product-ui";
import { IconLink, IconPhoneStroked } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./EcosystemSection.module.css";

const agentIcons: Record<string,string> = { "Claude Code": "/icons/lobe/claudecode-color.svg", Codex: "/icons/lobe/codex-color.svg", OpenCode: "/icons/lobe/opencode.svg", Pi: "/icons/lobe/pi.svg" };
const channelIds: Record<string,string> = { LongCat: "longcat", DeepSeek: "deepseek", Kimi: "kimi", Qwen: "qwen", "Z.AI": "zhipu", OpenRouter: "openrouter" };

export function EcosystemSection() {
  const { t } = useI18n();
  return <section id="ecosystem" className={styles.section}><div className={styles.inner}>
    <header><span>{t.ecosystem.eyebrow}</span><h2>{t.ecosystem.title}</h2><p>{t.ecosystem.subtitle}</p></header>
    <div className={styles.grid}>
      <article className={styles.card}><h3>Agent</h3><p>{t.ecosystem.agents[0].detail}</p><div className={styles.chips}>{t.ecosystem.agents.map((agent) => <span key={agent.name}><img src={agentIcons[agent.name]} alt="" /><strong>{agent.name}</strong></span>)}</div></article>
      <article className={styles.card}><h3>{t.ecosystem.channelsTitle}</h3><p>{t.ecosystem.subtitle}</p><div className={styles.chips}>{t.ecosystem.channels.map((channel) => <span key={channel}>{channelIds[channel] ? <ChannelBrandLogoView channelId={channelIds[channel]} name={channel} /> : <span className={styles.customMark}><IconLink /></span>}<strong>{channel}</strong></span>)}</div></article>
    </div>
    <div className={styles.mobile}><span><IconPhoneStroked /></span><div><h3>{t.ecosystem.mobileTitle}</h3><p>{t.ecosystem.mobileDesc}</p></div></div>
  </div></section>;
}
