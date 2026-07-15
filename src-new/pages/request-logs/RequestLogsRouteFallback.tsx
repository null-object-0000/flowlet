import { Typography } from "@douyinfe/semi-ui-19";
import styles from "./RequestLogsRouteFallback.module.css";

const { Paragraph, Title } = Typography;

export function RequestLogsRouteFallback() {
  return (
    <main className={styles.page} aria-busy="true">
      <header className={styles.header}>
        <div>
          <Title heading={3} style={{ margin: 0 }}>请求日志</Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>定位请求失败、路由切换与响应延迟</Paragraph>
        </div>
      </header>
      <section className={styles.panel}>
        <div className={styles.filterSkeleton} />
        <div className={styles.tableSkeleton} aria-label="请求日志表格加载中">
          <div className={styles.tableHead} />
          {Array.from({ length: 6 }, (_, index) => <div className={styles.tableRow} key={index} />)}
        </div>
      </section>
    </main>
  );
}
