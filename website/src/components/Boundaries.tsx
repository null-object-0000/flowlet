import { Typography } from "@douyinfe/semi-ui-19";
import { IconCrossCircleStroked } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Boundaries.module.css";

export function Boundaries() {
  const { t } = useI18n();

  return (
    <Section title={t.boundaries.title} subtitle={t.boundaries.subtitle}>
      <div className={styles.list}>
        {t.boundaries.items.map((item) => (
          <div key={item} className={styles.item}>
            <span className={styles.icon}>
              <IconCrossCircleStroked />
            </span>
            <Typography.Text type="secondary">{item}</Typography.Text>
          </div>
        ))}
      </div>
    </Section>
  );
}
