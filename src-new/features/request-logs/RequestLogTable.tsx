import type { RequestLogRow } from "../../domains/request-log/types";
import { formatDuration, isSuccessfulLog } from "./logPresentation";
import styles from "./RequestLogTable.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type Props = {
  rows: RequestLogRow[];
  loading: boolean;
  onOpenDetail: (requestId: string) => void;
};

export function RequestLogTable({ rows, loading, onOpenDetail }: Props) {
  const { language, t } = useAppPreferences();
  return (
    <div className={styles.scrollArea} role="table" aria-label={t("请求日志")}>
      <div className={`${styles.grid} ${styles.head}`} role="row">
        <span role="columnheader">{t("时间")}</span>
        <span role="columnheader">{t("模型 / 接口")}</span>
        <span role="columnheader">{t("渠道 / 账号")}</span>
        <span role="columnheader">{t("状态")}</span>
        <span role="columnheader">{t("耗时")}</span>
        <span role="columnheader">Token</span>
        <span role="columnheader">{t("费用")}</span>
      </div>

      <div className={styles.body}>
        {loading ? Array.from({ length: 7 }, (_, index) => <SkeletonRow key={index} index={index} />) : null}
        {!loading && rows.length === 0 ? (
          <div className={styles.empty}>
            <strong>{t("没有找到请求日志")}</strong>
            <span>{t("发起一次模型请求，或调整当前筛选条件后再试。")}</span>
          </div>
        ) : null}
        {!loading ? rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`${styles.grid} ${styles.row}`}
            aria-label={t("查看请求 {id}", { id: row.request_id })}
            onClick={() => onOpenDetail(row.request_id)}
          >
            <span className={styles.time}>{formatTime(row.created_at)}</span>
            <span className={styles.primaryCell}>
              <strong title={row.public_model || row.virtual_model || ""}>{row.public_model || row.virtual_model || "-"}</strong>
              <small title={`${row.method} ${row.path}`}><b>{row.method}</b> {row.path}{row.is_stream ? ` · ${t("流式")}` : ""}</small>
            </span>
            <span className={styles.primaryCell}>
              <strong>{row.channel_name || row.channel_id || t("未路由")}</strong>
              <small>{row.account_name || row.account_id || "-"}</small>
            </span>
            <Status row={row} />
            <span className={styles.number}>{formatDuration(row.duration_ms ?? row.latency_ms)}</span>
            <span className={styles.number}>{formatTokens(row.total_tokens, language)}</span>
            <span className={styles.number}>{formatCost(row.estimated_cost)}</span>
          </button>
        )) : null}
      </div>
    </div>
  );
}

function Status({ row }: { row: RequestLogRow }) {
  const { t } = useAppPreferences();
  const success = isSuccessfulLog(row);
  return <span className={`${styles.status} ${success ? styles.success : styles.failure}`}>{t(success ? "成功" : "失败")}</span>;
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">
      {Array.from({ length: 7 }, (_, column) => <span key={column} style={{ width: `${48 + ((index + column) % 4) * 12}%` }} />)}
    </div>
  );
}

function formatTime(value: string) {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTokens(value: number | null, language: "zh-CN" | "en-US") {
  if (value == null) return "—";
  return new Intl.NumberFormat(language).format(value);
}

function formatCost(value: number | null) {
  if (value == null) return "—";
  return `¥${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}
