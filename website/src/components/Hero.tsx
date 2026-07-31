import { Button, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconArrowRight, IconGithubLogo } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { AppMockup } from "./AppMockup";
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
              icon={<IconArrowRight />}
              iconPosition="right"
              onClick={() => document.querySelector("#quickstart")?.scrollIntoView({ behavior: "smooth" })}
            >
              {t.hero.ctaQuickstart}
            </Button>
            <Button
              size="large"
              icon={<IconGithubLogo />}
              onClick={() => window.open("https://github.com/null-object-0000/flowlet", "_blank", "noopener,noreferrer")}
            >
              {t.hero.ctaGithub}
            </Button>
          </div>
          <Typography.Text type="tertiary" size="small">
            {t.hero.note}
          </Typography.Text>
        </div>
        <div className={styles.visual}>
          <AppMockup />
        </div>
      </div>
    </section>
  );
}
