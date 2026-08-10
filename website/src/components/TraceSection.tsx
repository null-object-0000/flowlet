import { IconArrowRight, IconTickCircle } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./TraceSection.module.css";

export function TraceSection() {
  const { t } = useI18n();

  return (
    <section id="trace" className={styles.section}>
      <div className={styles.inner}>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>{t.trace.eyebrow}</span>
          <h2>{t.trace.title}</h2>
          <p>{t.trace.subtitle}</p>
        </div>
        <div className={styles.stage}>
          <div className={styles.flow}>
            {t.trace.steps.map((step, index) => (
              <div className={styles.flowItem} key={step}>
                <span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
                {index < t.trace.steps.length - 1 && <IconArrowRight className={styles.arrow} />}
              </div>
            ))}
            <div className={styles.result}>
              <IconTickCircle />
              <div><strong>{t.trace.resultTitle}</strong><p>{t.trace.resultDesc}</p></div>
            </div>
          </div>
          <div className={styles.logCard}>
            <div className={styles.logHeader}><strong>{t.trace.logTitle}</strong><span><i />{t.trace.logStatus}</span></div>
            <div className={styles.logBody}>
              {t.trace.logRows.map(([label, value]) => (
                <div className={styles.logRow} key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
            <div className={styles.timeline}><span /><span /><span /><span /><span /></div>
          </div>
        </div>
      </div>
    </section>
  );
}
