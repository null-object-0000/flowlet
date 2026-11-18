import { IconArrowDown, IconDownload } from "@douyinfe/semi-icons";
import { ChannelBrandLogoView } from "@flowlet/product-ui";
import { useI18n } from "../i18n/I18nContext";
import { AgentBrandIcon, type AgentBrandName } from "./AgentBrandIcon";
import { projectLinks } from "../projectLinks";
import styles from "./Hero.module.css";

const AGENTS: AgentBrandName[] = ["Claude Code", "Codex", "OpenCode", "Pi"];

export function Hero() {
  const { t } = useI18n();
  return <header className={styles.hero}>
    <div className={styles.grid}>
      <div className={styles.copy}>
        <div className={styles.eyebrow}>{t.hero.badge}</div>
        <h1>{t.hero.title}</h1>
        <p>{t.hero.subtitle}</p>
        <div className={styles.actions}>
          <a className={styles.primaryAction} href={projectLinks.releases}><IconDownload aria-hidden="true" />{t.hero.primary}</a>
          <a className={styles.secondaryAction} href={projectLinks.docker}>{t.hero.selfHost}</a>
          <a className={styles.demoAction} href="#demo">{t.hero.secondary}<IconArrowDown aria-hidden="true" /></a>
        </div>
        <div className={styles.notes}>{t.hero.notes.map((note) => <span key={note}>{note}</span>)}</div>
      </div>
      <div className={styles.flowCard} aria-label={t.hero.exampleLabel}>
        <div className={styles.flowTitle}><strong>{t.hero.flowTitle}</strong><span><i />{t.hero.running}</span></div>
        <div className={styles.agentRow}>{AGENTS.map((agent) => <div key={agent}><span className={styles.agentLogo}><AgentBrandIcon name={agent} /></span><span><strong>{agent}</strong><small>Agent</small></span></div>)}</div>
        <div className={styles.connector}><strong>{t.hero.endpointLabel}</strong></div>
        <div className={styles.routeRow}>{t.hero.routes.map((route, index) => <div key={route.name}><RouteLogo index={index} /><span><strong>{route.name}</strong><small>{route.detail}</small></span></div>)}</div>
        <div className={styles.traceMini}><span><strong>{t.hero.traceTitle}</strong><small>{t.hero.tracePath}</small></span><div><b>842 ms</b><b>18,420 tokens</b><b>{t.hero.estimatedCost}</b></div></div>
      </div>
    </div>
  </header>;
}

function RouteLogo({ index }: { index: number }) {
  if (index === 0) return <ChannelBrandLogoView channelId="deepseek" name="DeepSeek" />;
  if (index === 1) return <span className={styles.routeLogoStack}><ChannelBrandLogoView channelId="kimi" name="Kimi" /><ChannelBrandLogoView channelId="qwen" name="Qwen" /></span>;
  return <ChannelBrandLogoView channelId="openrouter" name="OpenRouter" />;
}
