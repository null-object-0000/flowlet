import { useI18n } from "../i18n/I18nContext";
import { AppMockup } from "./AppMockup";
import styles from "./ProductDemoSection.module.css";

export function ProductDemoSection() {
  const { t } = useI18n();
  return (
    <section id="demo" className={styles.section} aria-labelledby="product-demo-title">
      <div className={styles.inner}>
        <div className={styles.heading}>
          <span>{t.demo.eyebrow}</span>
          <h2 id="product-demo-title">{t.demo.title}</h2>
          <p>{t.demo.subtitle}</p>
        </div>
        <div className={styles.demoFrame}>
          <div className={styles.hint}><i />{t.demo.hint}</div>
          <AppMockup />
        </div>
      </div>
    </section>
  );
}
