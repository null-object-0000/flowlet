import { useI18n } from "../i18n/I18nContext";
import styles from "./Footer.module.css";

const GITHUB = "https://github.com/null-object-0000/flowlet";

export function Footer() {
  const { lang, t } = useI18n();

  const linkGroups = [
    {
      title: t.footer.product,
      links: [
        { label: "Releases", href: `${GITHUB}/releases` },
        { label: "README", href: GITHUB },
        { label: "Roadmap", href: `${GITHUB}/blob/main/docs/roadmap.md` },
      ],
    },
    {
      title: t.footer.project,
      links: [
        { label: "GitHub", href: GITHUB },
        { label: "Issues", href: `${GITHUB}/issues` },
        { label: "MIT License", href: `${GITHUB}/blob/main/LICENSE` },
      ],
    },
  ];

  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brandCol}>
          <a href={`/${lang}`} className={styles.brand}>
            <img src="/flowlet-logo.png" alt="Flowlet" className={styles.logo} />
            <span className={styles.brandName}>Flowlet</span>
          </a>
          <p className={styles.tagline}>{t.footer.tagline}</p>
        </div>
        <div className={styles.linkCols}>
          {linkGroups.map((group) => (
            <div key={group.title} className={styles.linkGroup}>
              <strong className={styles.groupTitle}>{group.title}</strong>
              {group.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.link}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <span>{t.footer.copyright.replace("{year}", String(new Date().getFullYear()))}</span>
      </div>
    </footer>
  );
}
