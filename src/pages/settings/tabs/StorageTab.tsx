import { Button } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";
import { useStorageMaintenance } from "../../../features/settings/useStorageMaintenance";
import { useStorageUsage } from "../../../features/settings/useStorageUsage";
import styles from "./StorageTab.module.css";

const CATEGORY_LABELS: Record<string, string> = {
  configuration: "配置与账号",
  requestLogs: "请求日志",
  requestCaptures: "请求明细文件",
  usage: "用量与费用",
  agentSessions: "Agent 会话",
  backgroundTasks: "后台任务",
  bodyData: "请求与响应 Body（按策略自动清理）",
};

export function StorageTab() {
  const { t } = useAppPreferences();
  const usage = useStorageUsage();
  const maintenance = useStorageMaintenance();
  const data = usage.isCounting ? usage.progress : (usage.data ?? usage.progress);
  const hasReclaimable = data.reclaimableBytes >= 1024 * 1024;

  return (
    <div>
      <div className={styles.summaryCard} data-keywords="存储空间 当前使用 清理 Body">
        <div className={styles.summaryMain}>
          <div className={styles.summaryLabel}>{t("当前本地数据占用")}</div>
          <div className={styles.summaryValue}>{formatBytes(data.totalBytes)}</div>
          <div className={styles.summaryMeta}>{t("查看数据库、请求明细和缓存文件的本地占用")}</div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${storageUsagePercent(data.totalBytes, data.captureBytes)}%` }}
            />
          </div>
        </div>
        <div className={styles.summaryActions}>
          {hasReclaimable
            ? <span className={styles.recommend}>{t("预计可释放 {size}", { size: formatBytes(data.reclaimableBytes) })}</span>
            : null}
          <Button
            type="primary"
            loading={maintenance.isPending}
            disabled={usage.isCounting || !hasReclaimable}
          >
            {t("清理建议")}
          </Button>
        </div>
      </div>

      <table className={styles.table} data-keywords="配置账号 请求日志 用量费用 Agent 会话 后台任务 Body">
        <thead>
          <tr>
            <th>{t("数据类型")}</th>
            <th className={styles.num}>{t("记录数")}</th>
            <th className={styles.num}>{t("占用空间")}</th>
            <th>{t("最近更新")}</th>
          </tr>
        </thead>
        <tbody>
          {data.categories.map((category, index) => (
            <tr key={category.key}>
              <td>
                <div className={styles.dataName}>
                  <i className={styles.dataDot} style={{ opacity: 1 - index * 0.13 }} />
                  {t(CATEGORY_LABELS[category.key] ?? category.key)}
                </div>
              </td>
              <td className={styles.num}>{category.rowCount.toLocaleString()}</td>
              <td className={styles.num}>{formatBytes(category.allocatedBytes)}</td>
              <td>{t("刚刚")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function storageUsagePercent(totalBytes: number, captureBytes: number): number {
  if (totalBytes <= 0 || captureBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((captureBytes / totalBytes) * 100)));
}
