import { useState, type ReactNode } from "react";
import { Button, CodeHighlight, JsonViewer, SideSheet, Tabs, Tag, Toast } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import type { RequestLogRow } from "../../domains/request-log/types";
import {
  calculateCacheHitRate,
  calculateOutputTokenRate,
  formatCapturedBody,
  formatCapturedJson,
  formatDuration,
  formatLogTime,
  formatPercentage,
  formatTokenRate,
  isSuccessfulLog,
  safeLogText,
} from "./logPresentation";
import { useRequestLogDetail } from "./useRequestLogs";
import styles from "./RequestLogDetailSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";

const JSON_VIEWER_OPTIONS = { readOnly: true, autoWrap: true } as const;

export function RequestLogDetailSideSheet({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const { language, t } = useAppPreferences();
  const detail = useRequestLogDetail(requestId);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const rows = detail.data ?? [];
  const finalRow = rows.length ? rows[rows.length - 1] : undefined;
  const selectedRow = rows.find((row) => row.id === selectedAttemptId) ?? finalRow;

  return (
    <SideSheet
      visible
      motion={false}
      width="min(760px, 96vw)"
      title={finalRow ? <DetailTitle row={finalRow} requestId={requestId} /> : <div className={styles.title}><strong>{t("请求详情")}</strong><span>{requestId}</span></div>}
      onCancel={onClose}
      footer={null}
      bodyStyle={{ padding: 0 }}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    >
      {detail.isLoading ? <DetailLoading /> : null}
      {detail.isError ? <DetailState title={t("请求详情加载失败")} description={safeLogText(detail.error.message)} action={<Button icon={<IconRefresh />} onClick={() => void detail.refetch()}>{t("重试")}</Button>} /> : null}
      {detail.isSuccess && !finalRow ? <DetailState title={t("未找到请求记录")} description={t("该日志可能已被清理。")} /> : null}

      {finalRow && selectedRow ? (
        <Tabs className={styles.tabs} type="line" defaultActiveKey="overview" tabPaneMotion={false}>
          <Tabs.TabPane tab={t("概览")} itemKey="overview">
            <div className={styles.tabContent}>
              <DetailSection title={t("路由信息")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("请求模型")} value={finalRow.public_model || finalRow.virtual_model || "-"} />
                  <DetailItem label={t("实际模型")} value={finalRow.upstream_model || "-"} />
                  <DetailItem label={t("渠道")} value={finalRow.channel_name || finalRow.channel_id || t("未路由")} />
                  <DetailItem label={t("账号")} value={finalRow.account_name || finalRow.account_id || "-"} />
                </div>
              </DetailSection>

              <DetailSection title={t("请求指标")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("开始时间")} value={formatLogTime(finalRow.created_at, language)} />
                  <DetailItem label={t("总耗时")} value={formatDuration(finalRow.duration_ms ?? finalRow.latency_ms)} />
                  <DetailItem label="TTFT" value={formatDuration(finalRow.ttft_ms)} />
                  <DetailItem label={t("输出速率")} value={formatTokenRate(calculateOutputTokenRate(finalRow))} />
                  <DetailItem label={t("输入 Token")} value={formatNumber(finalRow.input_tokens, language)} />
                  <DetailItem label={t("缓存命中率")} value={formatPercentage(calculateCacheHitRate(finalRow))} />
                  <DetailItem label={t("缓存输入 Token")} value={formatNumber(finalRow.input_cached_tokens, language)} />
                  <DetailItem label={t("未缓存输入 Token")} value={formatNumber(finalRow.input_uncached_tokens, language)} />
                  <DetailItem label={t("输出 Token")} value={formatNumber(finalRow.output_tokens, language)} />
                  <DetailItem label={t("预估费用")} value={formatCost(finalRow.estimated_cost)} />
                </div>
              </DetailSection>

              <DetailSection title={t("接口信息")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("请求接口")} value={`${finalRow.method} ${finalRow.path}`} />
                  <DetailItem label={t("客户端")} value={finalRow.client_name || finalRow.client_id || t("未知客户端")} />
                  <DetailItem label={t("客户端协议")} value={finalRow.client_protocol || "-"} />
                  <DetailItem label={t("HTTP 状态")} value={finalRow.status?.toString() || t("失败")} />
                </div>
              </DetailSection>

              {finalRow.error_message || finalRow.route_reason ? (
                <div className={styles.errorBox}>
                  <strong>{t(finalRow.error_message ? "错误信息" : "路由说明")}</strong>
                  <span>{safeLogText(finalRow.error_message || finalRow.route_reason)}</span>
                </div>
              ) : null}

              <AttemptSelector rows={rows} selectedRow={selectedRow} onSelect={setSelectedAttemptId} />
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("请求")} itemKey="request">
            <div className={styles.tabContent}>
              <AttemptSelector rows={rows} selectedRow={selectedRow} onSelect={setSelectedAttemptId} compact />
              <CapturedSection title={t("请求 Headers")} value={formatCapturedJson(selectedRow.req_headers_json, language)} />
              <CapturedSection title={t("请求 Body")} value={formatCapturedBody(selectedRow.req_body_b64, language)} />
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("响应")} itemKey="response">
            <div className={styles.tabContent}>
              <AttemptSelector rows={rows} selectedRow={selectedRow} onSelect={setSelectedAttemptId} compact />
              <CapturedSection title={t("响应 Headers")} value={formatCapturedJson(selectedRow.res_headers_json, language)} />
              <CapturedSection title={t("响应 Body")} value={formatCapturedBody(selectedRow.res_body_b64, language)} />
            </div>
          </Tabs.TabPane>
        </Tabs>
      ) : null}
    </SideSheet>
  );
}

function DetailTitle({ row, requestId }: { row: RequestLogRow; requestId: string }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.titleRow}>
      <StatusTag row={row} />
      <div className={styles.title}><strong>{t("请求详情")}</strong><span title={requestId}>{requestId}</span></div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><strong className={styles.sectionTitle}>{title}</strong>{children}</section>;
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div className={styles.detailItem}><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function AttemptSelector({ rows, selectedRow, onSelect, compact = false }: { rows: RequestLogRow[]; selectedRow: RequestLogRow; onSelect: (id: string) => void; compact?: boolean }) {
  const { t } = useAppPreferences();
  if (rows.length <= 1 && compact) return null;
  return (
    <section className={styles.section}>
      <div className={styles.attemptHeader}><strong className={styles.sectionTitle}>{t("尝试链路")}</strong><span>{t("共 {count} 次", { count: rows.length })}</span></div>
      <div className={styles.attempts}>
        {rows.map((row, index) => (
          <button key={row.id} type="button" className={`${styles.attempt} ${selectedRow.id === row.id ? styles.selected : ""}`} onClick={() => onSelect(row.id)}>
            <i>{index + 1}</i>
            <span><strong>{row.channel_name || row.channel_id || t("未路由")} · {row.account_name || row.account_id || "-"}</strong><small>{row.error_message || row.route_reason ? safeLogText(row.error_message || row.route_reason) : t("请求完成")}</small></span>
            <span className={styles.attemptMeta}><StatusTag row={row} /><small>{formatDuration(row.duration_ms ?? row.latency_ms)}</small></span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusTag({ row }: { row: RequestLogRow }) {
  const { t } = useAppPreferences();
  return isSuccessfulLog(row) ? <Tag size="small" color="green">{t("成功")}</Tag> : <Tag size="small" color="red">{t("失败")}</Tag>;
}

function CapturedSection({ title, value }: { title: string; value: string }) {
  const { t } = useAppPreferences();
  const isJson = isJsonDocument(value);
  const viewerHeight = title.includes("Headers") ? 220 : 300;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{title} 已复制", { title }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  return (
    <section className={styles.capture}>
      <div><span><strong>{title}</strong><small>{t("敏感凭据已隐藏")}</small></span><Button aria-label={t("复制{title}", { title })} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copy()} /></div>
      {isJson ? (
        <div className={styles.jsonContainer}>
          <JsonViewer
            className={styles.jsonViewer}
            value={value}
            width="100%"
            height={viewerHeight}
            showSearch
            limitSearchButtonBounds
            options={JSON_VIEWER_OPTIONS}
          />
          <span className={styles.srOnly}>{value}</span>
        </div>
      ) : (
        <CodeHighlight
          className={styles.codeViewer}
          code={value}
          language="text"
          lineNumber={value.includes("\n")}
        />
      )}
    </section>
  );
}

function isJsonDocument(value: string) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function DetailLoading() {
  const { t } = useAppPreferences();
  return <div className={styles.loading} aria-label={t("请求详情加载中")}>{Array.from({ length: 8 }, (_, index) => <span key={index} style={{ width: `${55 + (index % 3) * 15}%` }} />)}</div>;
}

function DetailState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className={styles.state}><strong>{title}</strong>{description ? <span>{description}</span> : null}{action}</div>;
}

function formatNumber(value: number | null, language: "zh-CN" | "en-US") {
  return value == null ? "—" : new Intl.NumberFormat(language).format(value);
}

function formatCost(value: number | null) {
  if (value == null) return "—";
  return `¥${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}
