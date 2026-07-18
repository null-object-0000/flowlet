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
  formatEntryRequestUrl,
  formatLogTime,
  formatPercentage,
  formatTokenRate,
  isPreRoutingFailure,
  isSuccessfulLog,
  safeLogText,
} from "./logPresentation";
import { useRequestLogDetail } from "./useRequestLogs";
import styles from "./RequestLogDetailSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";

const JSON_VIEWER_OPTIONS = { readOnly: true, autoWrap: true } as const;
type Translate = (source: string, variables?: Record<string, string | number>) => string;

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
              <AttemptSelector rows={rows} selectedRow={selectedRow} onSelect={setSelectedAttemptId} />

              <DetailSection title={t("接口信息")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("入口请求地址")} value={formatEntryRequestUrl(selectedRow)} wide copyable />
                  <DetailItem
                    label={t("底层接口地址")}
                    value={selectedRow.upstream_url || (isPreRoutingFailure(selectedRow) ? t("未发往上游（路由前失败）") : t("旧日志未记录"))}
                    wide
                    copyable={Boolean(selectedRow.upstream_url)}
                  />
                  <DetailItem label={t("请求接口")} value={`${selectedRow.method} ${selectedRow.path}`} />
                  <DetailItem label={t("客户端")} value={selectedRow.client_name || selectedRow.client_id || t("未知客户端")} />
                  <DetailItem label={t("客户端协议")} value={selectedRow.client_protocol || "-"} />
                  <DetailItem label={t("HTTP 状态")} value={selectedRow.status?.toString() || t("失败")} />
                </div>
              </DetailSection>

              {finalRow.error_message ? (
                <div className={styles.errorBox}>
                  <strong>{t("错误信息")}</strong>
                  <span>{safeLogText(finalRow.error_message)}</span>
                </div>
              ) : null}
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("性能")} itemKey="performance">
            <div className={styles.tabContent}>
              <DetailSection title={t("响应性能")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("开始时间")} value={formatLogTime(finalRow.created_at, language)} />
                  <DetailItem label={t("总耗时")} value={formatDuration(finalRow.duration_ms ?? finalRow.latency_ms)} />
                  <DetailItem label="TTFT" value={formatDuration(finalRow.ttft_ms)} />
                  <DetailItem label={t("生成耗时")} value={formatGenerationDuration(finalRow)} />
                  <DetailItem label={t("输出速率")} value={formatTokenRate(calculateOutputTokenRate(finalRow))} />
                  <DetailItem label={t("预估费用")} value={formatCost(finalRow.estimated_cost)} />
                </div>
              </DetailSection>

              <DetailSection title={t("Token 明细")}>
                <div className={styles.detailGrid}>
                  <DetailItem label={t("总 Token")} value={formatNumber(finalRow.total_tokens, language)} />
                  <DetailItem label={t("输入 Token")} value={formatNumber(finalRow.input_tokens, language)} />
                  <DetailItem label={t("缓存输入 Token")} value={formatNumber(finalRow.input_cached_tokens, language)} />
                  <DetailItem label={t("未缓存输入 Token")} value={formatNumber(finalRow.input_uncached_tokens, language)} />
                  <DetailItem label={t("输出 Token")} value={formatNumber(finalRow.output_tokens, language)} />
                  <DetailItem label={t("缓存命中率")} value={formatPercentage(calculateCacheHitRate(finalRow))} />
                </div>
              </DetailSection>
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

function DetailItem({ label, value, wide = false, copyable = false }: { label: string; value: string; wide?: boolean; copyable?: boolean }) {
  const { t } = useAppPreferences();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{label} 已复制", { label }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  return (
    <div className={`${styles.detailItem} ${wide ? styles.detailItemWide : ""}`}>
      <span>{label}</span>
      <div className={styles.detailItemValue}>
        <strong title={value}>{value}</strong>
        {copyable ? <Button aria-label={t("复制{label}", { label })} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copy()} /> : null}
      </div>
    </div>
  );
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
            <span>
              <strong>{row.channel_name || row.channel_id || t("未路由")} · {row.account_name || row.account_id || "-"}</strong>
              <small title={attemptDetail(row, t)}>{attemptDetail(row, t)}</small>
            </span>
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
      <div><span><strong>{title}</strong></span><Button aria-label={t("复制{title}", { title })} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copy()} /></div>
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

function formatGenerationDuration(row: RequestLogRow) {
  if (row.duration_ms == null || row.ttft_ms == null || row.duration_ms < row.ttft_ms) return "—";
  return formatDuration(row.duration_ms - row.ttft_ms);
}

function attemptDetail(row: RequestLogRow, t: Translate) {
  const requestedModel = row.public_model || row.virtual_model;
  const upstreamModel = row.upstream_model;
  const model = requestedModel && upstreamModel && requestedModel !== upstreamModel
    ? `${requestedModel} → ${upstreamModel}`
    : t("模型 {model}", { model: upstreamModel || requestedModel || "—" });
  const outcome = row.error_message ? safeLogText(row.error_message) : routeReasonLabel(row.route_reason, t);
  return `${model} · ${outcome}`;
}

function routeReasonLabel(reason: string | null, t: Translate) {
  const labels: Record<string, string> = {
    direct: "直接路由",
    primary: "直接路由",
    auto: "自动路由",
    fallback_success: "回退成功",
    retryable_status: "状态异常，准备回退",
    quota_exceeded: "额度不足，准备回退",
    network_timeout: "上游超时",
    network_connect: "上游连接失败",
    network_request: "上游请求失败",
    network_error: "上游网络错误",
  };
  if (!reason) return t("请求完成");
  const fallbackBase = reason.endsWith("_fallback") ? reason.slice(0, -"_fallback".length) : null;
  if (fallbackBase) return t("{reason}后回退", { reason: t(labels[fallbackBase] || fallbackBase) });
  return t(labels[reason] || reason);
}
