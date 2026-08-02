import styles from "./RequestLogsRouteFallback.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { PageHeader } from "../../shared/ui/PageHeader";

export function RequestLogsRouteFallback() {
  const { t } = useAppPreferences();
  return (
    <main className={styles.page} aria-busy="true">
      <PageHeader title={t("请求日志")} subtitle={t("查看代理服务的实时请求、模型路由和 Token 消耗")}>
        <div className={styles.liveSkeleton} />
      </PageHeader>
      <section className={styles.stats}>{Array.from({ length: 4 }, (_, index) => <div className={styles.stat} key={index}><i /><span /></div>)}</section>
      <div className={styles.toolbarSkeleton} />
      <section className={styles.tableSkeleton} aria-label={t("请求日志表格加载中")}>
        <div className={styles.tableHead} />
        {Array.from({ length: 8 }, (_, index) => <div className={styles.tableRow} key={index} />)}
        <div className={styles.tableFooter} />
      </section>
    </main>
  );
}
