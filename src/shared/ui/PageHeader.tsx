import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

type PageHeaderProps = {
  title: ReactNode;
  subtitle?: string;
  /** 右上角控件区：RefreshControl、筛选器、页面动作等。 */
  children?: ReactNode;
};

/**
 * 全站统一的页面页头：左侧标题 + 副标题，右侧控件区。
 * 所有带右上角控件的页面（请求日志、会话管理、任务日志、用量统计、
 * 用量洞察、模型服务、应用设置）必须使用它，避免各页自行排版产生
 * 对齐、间距和字号上的细微差异。
 */
export function PageHeader({ title, subtitle, children }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {children ? <div className={styles.controls}>{children}</div> : null}
    </header>
  );
}
