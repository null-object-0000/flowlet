import { Card, Typography } from "@douyinfe/semi-ui-19";
import {
  IconBolt,
  IconServer,
  IconShield,
  IconEyeOpened,
  IconSetting,
  IconCoinMoneyStroked,
} from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Features.module.css";

const icons = [
  IconServer,
  IconSetting,
  IconShield,
  IconEyeOpened,
  IconCoinMoneyStroked,
  IconBolt,
];

export function Features() {
  const { t } = useI18n();

  return (
    <Section id="features" title={t.features.title} subtitle={t.features.subtitle}>
      <div className={styles.grid}>
        {t.features.items.map((item, i) => {
          const Icon = icons[i] ?? IconServer;
          return (
            <Card key={item.title} className={styles.card} bodyStyle={{ padding: 24 }}>
              <div className={styles.iconWrap}>
                <Icon size="large" />
              </div>
              <Typography.Title heading={4} className={styles.cardTitle}>
                {item.title}
              </Typography.Title>
              <Typography.Paragraph type="secondary" className={styles.cardDesc}>
                {item.desc}
              </Typography.Paragraph>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
