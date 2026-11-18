import { Button, Layout } from "@douyinfe/semi-ui-19";
import { IconDownload, IconGithubLogo, IconLanguage, IconMoon, IconSun } from "@douyinfe/semi-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { LANGS, useI18n } from "../i18n/I18nContext";
import { useTheme } from "../styles/ThemeContext";
import { projectLinks } from "../projectLinks";
import styles from "./Nav.module.css";

export function Nav() {
  const { lang, t } = useI18n();
  const { effective, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  const otherLang = LANGS.find((l) => l !== lang) ?? "en";

  const anchors = [
    { href: "#demo", label: t.nav.demo },
    { href: "#trace", label: t.nav.trace },
    { href: "#ecosystem", label: t.nav.ecosystem },
    { href: "#start", label: t.nav.start },
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
            icon={effective === "dark" ? <IconSun /> : <IconMoon />}
            theme="borderless"
            className={styles.themeButton}
            onClick={toggle}
            aria-label={effective === "dark" ? t.nav.themeLight : t.nav.themeDark}
            aria-pressed={effective === "dark"}
          />
          <Button
            icon={<IconLanguage />}
            theme="borderless"
            className={styles.languageButton}
            onClick={switchLang}
            aria-label={otherLang === "zh" ? "Switch to Chinese" : "Switch to English"}
          >
            {otherLang === "zh" ? "中" : "EN"}
          </Button>
          <Button
            icon={<IconGithubLogo />}
            theme="borderless"
            className={styles.githubButton}
            onClick={() => window.open(projectLinks.repository, "_blank", "noopener,noreferrer")}
          >
            {t.nav.github}
          </Button>
          <Button
            icon={<IconDownload />}
            theme="solid"
            type="primary"
            className={styles.downloadButton}
            aria-label={t.hero.primary}
            onClick={() => window.open(projectLinks.releases, "_blank", "noopener,noreferrer")}
          >
            <span className={styles.downloadLabel}>{t.nav.download}</span>
          </Button>
        </div>
      </div>
    </Layout.Header>
  );
}
