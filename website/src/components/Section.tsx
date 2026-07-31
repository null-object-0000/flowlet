import type { ReactNode } from "react";
import { Typography } from "@douyinfe/semi-ui-19";
import styles from "./Section.module.css";

interface SectionProps {
  id?: string;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

/** 落地页通用 section:统一最大宽度、纵向节奏和标题层级。 */
export function Section({ id, title, subtitle, children }: SectionProps) {
  return (
    <section id={id} className={styles.section}>
      <div className={styles.inner}>
        {title ? (
          <div className={styles.header}>
            <Typography.Title heading={2} className={styles.title}>
              {title}
            </Typography.Title>
            {subtitle ? (
              <Typography.Paragraph type="secondary" className={styles.subtitle}>
                {subtitle}
              </Typography.Paragraph>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}
