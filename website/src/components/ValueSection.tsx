import { IconBolt, IconCoinMoneyStroked, IconEyeOpened, IconServer } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./ValueSection.module.css";

const icons = [IconServer, IconEyeOpened, IconCoinMoneyStroked, IconBolt];

export function ValueSection() {
  const { t } = useI18n();

  return (
    <section id="value" className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>{t.value.eyebrow}</span>
          <h2>{t.value.title}</h2>
          <p>{t.value.subtitle}</p>
        </div>
        <div className={styles.grid}>
          {t.value.items.map((item, index) => {
            const Icon = icons[index] ?? IconServer;
            return (
              <article className={styles.card} key={item.title}>
                <div className={styles.cardTop}><span className={styles.icon}><Icon /></span><span className={styles.kicker}>{item.kicker}</span></div>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
