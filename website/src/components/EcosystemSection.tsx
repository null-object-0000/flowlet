import { IconPhoneStroked } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./EcosystemSection.module.css";

const icons: Record<string, string> = {
  "Claude Code": "/icons/lobe/claudecode.svg",
  Codex: "/icons/lobe/codex.svg",
  OpenCode: "/icons/lobe/opencode.svg",
  Pi: "/icons/lobe/pi.svg",
};

const channelIcons: Record<string, string> = {
  LongCat: "/icons/lobe/longcat-color.svg",
  DeepSeek: "/icons/lobe/deepseek-color.svg",
  Kimi: "/icons/lobe/kimi-color.svg",
  Qwen: "/icons/lobe/qwen-color.svg",
};

export function EcosystemSection() {
  const { t } = useI18n();
  return (
    <section id="ecosystem" className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>{t.ecosystem.eyebrow}</span>
          <h2>{t.ecosystem.title}</h2>
          <p>{t.ecosystem.subtitle}</p>
        </div>
        <div className={styles.agents}>
          {t.ecosystem.agents.map((agent) => (
            <article key={agent.name} className={styles.agentCard}>
              <img src={icons[agent.name]} alt="" />
              <div><h3>{agent.name}</h3><p>{agent.detail}</p></div>
              <span className={styles.connected}><i /></span>
            </article>
          ))}
        </div>
        <div className={styles.bottomGrid}>
          <div className={styles.channels}>
            <h3>{t.ecosystem.channelsTitle}</h3>
            <div className={styles.channelList}>
              {t.ecosystem.channels.map((channel) => (
                <span key={channel}>{channelIcons[channel] && <img src={channelIcons[channel]} alt="" />}{channel}</span>
              ))}
            </div>
          </div>
          <div className={styles.mobile}>
            <span className={styles.mobileIcon}><IconPhoneStroked /></span>
            <div><h3>{t.ecosystem.mobileTitle}</h3><p>{t.ecosystem.mobileDesc}</p></div>
          </div>
        </div>
      </div>
    </section>
  );
}
