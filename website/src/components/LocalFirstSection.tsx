import { IconCloud, IconHome, IconLink } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./LocalFirstSection.module.css";

const ICONS = [IconHome, IconLink, IconCloud];

export function LocalFirstSection() {
  const { t } = useI18n();
  return <section className={styles.section}><div className={styles.inner}>
    <header><span>{t.local.eyebrow}</span><h2>{t.local.title}</h2><p>{t.local.subtitle}</p></header>
    <div className={styles.list}>{t.local.items.map((item,index) => { const Icon = ICONS[index] ?? IconHome; return <article key={item.title}><span><Icon /></span><div><h3>{item.title}</h3><p>{item.desc}</p></div></article>; })}</div>
  </div></section>;
}
