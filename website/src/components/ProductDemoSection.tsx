import { useState } from "react";
import { MobileCompanionDemoView } from "@flowlet/product-ui";
import { useI18n } from "../i18n/I18nContext";
import { AppMockup } from "./AppMockup";
import styles from "./ProductDemoSection.module.css";

export function ProductDemoSection() {
  const { lang, t } = useI18n();
  const [surface, setSurface] = useState<"desktop" | "mobile">(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop"
  );
  const mobile = surface === "mobile";
  return (
    <section id="demo" className={styles.section} aria-labelledby="product-demo-title">
      <div className={styles.inner}>
        <div className={styles.heading}>
          <span>{t.demo.eyebrow}</span>
          <h2 id="product-demo-title">{mobile ? t.demo.mobileTitle : t.demo.title}</h2>
          <p>{mobile ? t.demo.mobileSubtitle : t.demo.subtitle}</p>
          <div className={styles.surfaceSwitch} role="tablist" aria-label={t.demo.eyebrow}>
            <button type="button" role="tab" aria-selected={!mobile} onClick={() => setSurface("desktop")}>{t.demo.desktopTab}</button>
            <button type="button" role="tab" aria-selected={mobile} onClick={() => setSurface("mobile")}>{t.demo.mobileTab}</button>
          </div>
        </div>
        <div className={`${styles.demoFrame} ${mobile ? styles.mobileFrame : ""}`}>
          {mobile ? <MobileCompanionDemoView zh={lang === "zh"} /> : <AppMockup />}
        </div>
      </div>
    </section>
  );
}
