import { Button, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconDownload, IconGithubLogo } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import styles from "./Hero.module.css";

export function Hero() {
  const { t } = useI18n();

  return (
    <section className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.copy}>
          <Tag color="blue" className={styles.badge}>
            {t.hero.badge}
          </Tag>
          <Typography.Title heading={1} className={styles.title}>
            {t.hero.title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" className={styles.subtitle}>
            {t.hero.subtitle}
          </Typography.Paragraph>
          <div className={styles.actions}>
            <Button
              theme="solid"
              type="primary"
              size="large"
              icon={<IconDownload />}
              onClick={() => window.open("https://github.com/null-object-0000/flowlet/releases", "_blank", "noopener,noreferrer")}
            >
              {t.hero.primary}
            </Button>
            <Button
              size="large"
              icon={<IconGithubLogo />}
              onClick={() => window.open("https://github.com/null-object-0000/flowlet", "_blank", "noopener,noreferrer")}
            >
              {t.hero.secondary}
            </Button>
          </div>
          <div className={styles.platformNote}>{t.hero.platform}</div>
        </div>
        <div className={styles.metrics} aria-label="Flowlet capabilities">
          <span>{t.hero.endpoint}</span>
          <span>{t.hero.agents}</span>
          <span>{t.hero.protocols}</span>
        </div>
      </div>
    </section>
  );
}
