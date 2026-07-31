import { Card, Typography } from "@douyinfe/semi-ui-19";
import { IconSafeStroked } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Security.module.css";

export function Security() {
  const { t } = useI18n();

  return (
    <Section id="security" title={t.security.title}>
      <Card className={styles.card} bodyStyle={{ padding: 28 }}>
        <div className={styles.headerRow}>
          <div className={styles.iconWrap}>
            <IconSafeStroked size="large" />
          </div>
        </div>
        <ul className={styles.list}>
          {t.security.items.map((item) => (
            <li key={item}>
              <Typography.Text type="secondary">{item}</Typography.Text>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}
