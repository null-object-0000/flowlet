import { IconSafeStroked } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./LocalFirstSection.module.css";

export function LocalFirstSection() {
  const { t } = useI18n();
  return (
    <section className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.icon}><IconSafeStroked /></div>
        <div className={styles.copy}><span>{t.local.eyebrow}</span><h2>{t.local.title}</h2></div>
        <div className={styles.items}>
          {t.local.items.map((item) => <div key={item.title}><h3>{item.title}</h3><p>{item.desc}</p></div>)}
        </div>
      </div>
    </section>
  );
}
