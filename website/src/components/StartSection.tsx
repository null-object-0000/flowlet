import { Button } from "@douyinfe/semi-ui-19";
import { IconArrowRight, IconGithubLogo } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./StartSection.module.css";

const GITHUB = "https://github.com/null-object-0000/flowlet";

export function StartSection() {
  const { t } = useI18n();
  return (
    <section id="start" className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.heading}><span>{t.start.eyebrow}</span><h2>{t.start.title}</h2></div>
        <div className={styles.steps}>
          {t.start.steps.map((step) => (
            <article key={step.number}><strong>{step.number}</strong><h3>{step.title}</h3><p>{step.desc}</p></article>
          ))}
        </div>
        <div className={styles.cta}>
          <div><h2>{t.start.ctaTitle}</h2><p>{t.start.ctaDesc}</p></div>
          <div className={styles.actions}>
            <Button size="large" theme="solid" type="primary" icon={<IconArrowRight />} iconPosition="right" onClick={() => window.open(`${GITHUB}/releases`, "_blank", "noopener,noreferrer")}>{t.start.primary}</Button>
            <Button size="large" icon={<IconGithubLogo />} onClick={() => window.open(GITHUB, "_blank", "noopener,noreferrer")}>{t.start.secondary}</Button>
          </div>
        </div>
        <div className={styles.notice}><strong>{t.start.noticeTitle}</strong><p>{t.start.notice}</p></div>
      </div>
    </section>
  );
}
