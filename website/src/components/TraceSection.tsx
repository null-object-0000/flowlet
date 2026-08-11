import { useI18n } from "../i18n/I18nContext";
import styles from "./TraceSection.module.css";

export function TraceSection() {
  const { t } = useI18n();
  return <section id="trace" className={styles.section}><div className={styles.inner}>
    <header><span>{t.trace.eyebrow}</span><h2>{t.trace.title}</h2><p>{t.trace.subtitle}</p></header>
    <div className={styles.grid}>
      <div className={styles.steps}>{t.trace.steps.map((step,index) => <div key={step} className={styles.step}><span>{String(index + 1).padStart(2,"0")}</span><div><strong>{step}</strong><small>{t.trace.stepDetails[index]}</small></div></div>)}</div>
      <div className={styles.request}><div className={styles.requestHead}><strong>{t.trace.logTitle}</strong><span><i />{t.trace.logStatus}</span></div><div className={styles.rows}>{t.trace.logRows.map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className={styles.timeline}>{Array.from({length:5},(_,index) => <span key={index} />)}</div></div>
    </div>
  </div></section>;
}
