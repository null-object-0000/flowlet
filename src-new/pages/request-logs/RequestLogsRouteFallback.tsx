import { Typography } from "@douyinfe/semi-ui-19";
import styles from "./RequestLogsRouteFallback.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Title } = Typography;

export function RequestLogsRouteFallback() {
  const { t } = useAppPreferences();
  return (
    <main className={styles.page} aria-busy="true">
      <header className={styles.header}>
        <div><Title heading={3} style={{ margin: 0 }}>{t("请求日志")}</Title><Paragraph type="tertiary" style={{ margin: 0 }}>{t("查看代理服务的实时请求、模型路由和 Token 消耗")}</Paragraph></div>
        <div className={styles.liveSkeleton} />
      </header>
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
