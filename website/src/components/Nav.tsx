import { Button, Layout } from "@douyinfe/semi-ui-19";
import { IconGithubLogo, IconLanguage } from "@douyinfe/semi-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { LANGS, useI18n } from "../i18n/I18nContext";
import styles from "./Nav.module.css";

export function Nav() {
  const { lang, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const otherLang = LANGS.find((l) => l !== lang) ?? "en";

  const anchors = [
    { href: "#features", label: t.nav.features },
    { href: "#channels", label: t.nav.channels },
    { href: "#agents", label: t.nav.agents },
    { href: "#quickstart", label: t.nav.quickstart },
  ];

  function switchLang() {
    const newPath = `/${otherLang}${location.hash}`;
    navigate(newPath, { replace: true });
  }

  return (
    <Layout.Header className={styles.header}>
      <div className={styles.inner}>
        <a href={`/${lang}`} className={styles.brand}>
          <img src="/flowlet-logo.png" alt="Flowlet" className={styles.logo} />
          <span className={styles.brandName}>Flowlet</span>
        </a>
        <nav className={styles.links}>
          {anchors.map((a) => (
            <a key={a.href} href={a.href} className={styles.link}>
              {a.label}
            </a>
          ))}
        </nav>
        <div className={styles.actions}>
          <Button
            icon={<IconLanguage />}
            theme="borderless"
            onClick={switchLang}
            aria-label={otherLang === "zh" ? "Switch to Chinese" : "Switch to English"}
          >
            {otherLang === "zh" ? "中" : "EN"}
          </Button>
          <Button
            icon={<IconGithubLogo />}
            theme="borderless"
            onClick={() => window.open("https://github.com/null-object-0000/flowlet", "_blank", "noopener,noreferrer")}
          >
            {t.nav.github}
          </Button>
        </div>
      </div>
    </Layout.Header>
  );
}
