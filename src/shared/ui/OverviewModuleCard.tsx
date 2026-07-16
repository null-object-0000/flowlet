import type { ReactNode } from "react";
import { Card, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronRight } from "@douyinfe/semi-icons";
import { OverviewActionLink } from "./OverviewActionLink";
import styles from "./OverviewModuleCard.module.css";

const { Title } = Typography;

type Props = {
  title: ReactNode;
  description?: ReactNode;
  action?: string;
  onAction?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
};

export function OverviewModuleCard({ title, description, action, onAction, headerExtra, children }: Props) {
  return (
    <Card className={styles.card}>
      <div className={styles.body}>
        <div className={styles.header}>
          <Title heading={5} style={{ margin: 0 }}>{title}</Title>
          {headerExtra ?? (action && onAction ? (
            <OverviewActionLink trailingIcon={<IconChevronRight />} onClick={onAction}>
              {action}
            </OverviewActionLink>
          ) : null)}
        </div>
        {description ? <div className={styles.description}>{description}</div> : null}
        <div className={styles.content}>
          {children}
        </div>
      </div>
    </Card>
  );
}
