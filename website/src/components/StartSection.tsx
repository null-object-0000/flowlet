import { IconArrowRight } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { projectLinks } from "../projectLinks";
import styles from "./StartSection.module.css";

export function StartSection() {
  const { t } = useI18n();
  return (
    <section id="start" className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.heading}><span>{t.start.eyebrow}</span><h2>{t.start.title}</h2><p>{t.start.subtitle}</p></div>
        <div className={styles.steps}>
          {t.start.steps.map((step) => (
            <article key={step.number}><strong>{step.number}</strong><h3>{step.title}</h3><p>{step.desc}</p></article>
          ))}
        </div>
        <div className={styles.cta}>
          <div><h2>{t.start.ctaTitle}</h2><p>{t.start.ctaDesc}</p></div>
          <div className={styles.actions}>
            <a href={projectLinks.releases}>{t.hero.primary}<IconArrowRight aria-hidden="true" /></a>
            <a href={projectLinks.docker}>{t.hero.selfHost}</a>
          </div>
        </div>
      </div>
    </section>
  );
}
