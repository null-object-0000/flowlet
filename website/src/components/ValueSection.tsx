import { IconCoinMoneyStroked, IconEyeOpened, IconServer } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./ValueSection.module.css";

const ICONS = [IconServer, IconEyeOpened, IconCoinMoneyStroked];

export function ValueSection() {
  const { t } = useI18n();
  return <section id="why" className={styles.section}><div className={styles.inner}>
    <header><span>{t.value.eyebrow}</span><h2>{t.value.title}</h2><p>{t.value.subtitle}</p></header>
    <div className={styles.grid}>{t.value.items.map((item, index) => { const Icon = ICONS[index] ?? IconServer; return <article key={item.title}><span className={styles.icon}><Icon /></span><h3>{item.title}</h3><p>{item.desc}</p></article>; })}</div>
  </div></section>;
}
