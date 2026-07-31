import { Typography } from "@douyinfe/semi-ui-19";
import { useI18n } from "../i18n/I18nContext";
import styles from "./Footer.module.css";

const GITHUB = "https://github.com/null-object-0000/flowlet";

export function Footer() {
  const { lang, t } = useI18n();

  const linkGroups = [
    {
      title: t.footer.links,
      links: [
        { label: "GitHub", href: GITHUB },
        { label: "Issues", href: `${GITHUB}/issues` },
        { label: "Releases", href: `${GITHUB}/releases` },
      ],
    },
    {
      title: t.footer.docs,
      links: [
        { label: "Support Matrix", href: `${GITHUB}/blob/main/docs/support-matrix.md` },
        { label: "Architecture", href: `${GITHUB}/blob/main/docs/architecture.md` },
        { label: "Roadmap", href: `${GITHUB}/blob/main/docs/roadmap.md` },
      ],
    },
    {
      title: t.footer.license,
      links: [{ label: "MIT License", href: `${GITHUB}/blob/main/LICENSE` }],
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
          <Typography.Paragraph type="secondary" size="small" className={styles.tagline}>
            {t.footer.tagline}
          </Typography.Paragraph>
        </div>
        <div className={styles.linkCols}>
          {linkGroups.map((group) => (
            <div key={group.title} className={styles.linkGroup}>
              <Typography.Text strong className={styles.groupTitle}>
                {group.title}
              </Typography.Text>
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
        <Typography.Text type="tertiary" size="small">
          {t.footer.copyright.replace("{year}", String(new Date().getFullYear()))}
        </Typography.Text>
      </div>
    </footer>
  );
}
