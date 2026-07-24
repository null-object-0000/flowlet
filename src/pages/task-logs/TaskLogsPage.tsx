import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Pagination, Progress, Select, SideSheet, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete } from "@douyinfe/semi-icons";
import { useSearchParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_BACKGROUND_JOBS_FILTER, type BackgroundJobRow, type BackgroundJobsFilter } from "../../domains/background-task/types";
import { useBackgroundTaskDetail, useBackgroundTasks, useCancelBackgroundTask, useCleanupBackgroundTasks } from "../../features/background-tasks/useBackgroundTasks";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./TaskLogsPage.module.css";
import { formatJobDuration } from "./taskDuration";

const { Paragraph, Text, Title } = Typography;
type Translate = (key: string, variables?: Record<string, string | number>) => string;

export function TaskLogsPage() {
  const { language, t } = useAppPreferences();
  const [filter, setFilter] = useState<BackgroundJobsFilter>(DEFAULT_BACKGROUND_JOBS_FILTER);
  const refresh = useRefreshControl({ intervalMs: 10_000 });
  const tasks = useBackgroundTasks(filter, refresh.autoRefresh);
  const now = useElapsedNow(Boolean(tasks.data?.rows.some((job) => job.status === "running")));
  const cleanup = useCleanupBackgroundTasks();
  const [searchParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(() => searchParams.get("jobId"));

  const confirmCleanup = () => Modal.confirm({
    title: t("清理任务日志"),
    content: t("删除 90 天前已结束的任务与处理记录，运行中的任务不会受影响。"),
    okText: t("确认清理"), cancelText: t("取消"), zIndex: APP_OVERLAY_Z_INDEX.modal,
    onOk: async () => {
      try {
        const result = await cleanup.mutateAsync(90);
        Toast.success(t("已清理 {jobs} 个任务、{events} 条处理记录", { jobs: result.deletedJobs, events: result.deletedEvents }));
      } catch (error) {
        Toast.error(t("任务操作失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    },
  });

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><Title heading={3}>{t("任务日志")}</Title><Paragraph type="tertiary">{t("查看后台处理任务的进度、性能、结果与错误")}</Paragraph></div>
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={tasks.isFetching}
        lastUpdatedAt={tasks.dataUpdatedAt}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void tasks.refetch()}
        language={language}
        t={t}
      />
    </header>
    <section className={styles.toolbar} aria-label={t("任务筛选")}>
      <Select insetLabel={t("状态")} value={filter.status || "__all__"} optionList={statusOptions(t)} onChange={(value) => setFilter((current) => ({ ...current, status: value === "__all__" ? "" : String(value) as BackgroundJobsFilter["status"], page: 1 }))} />
      <Select insetLabel={t("任务类型")} value={filter.jobType || "__all__"} optionList={[{ value: "__all__", label: t("全部类型") }, { value: "body-cleanup", label: t("Body 清理") }, { value: "agent-data-sync", label: t("Agent 数据同步") }, { value: "codex-account-sync", label: t("Codex 账号同步") }, { value: "channel-resource-sync", label: t("渠道资源自动同步") }]} onChange={(value) => setFilter((current) => ({ ...current, jobType: value === "__all__" ? "" : String(value), page: 1 }))} />
      <Select insetLabel={t("触发方式")} value={filter.triggerSource || "__all__"} optionList={triggerOptions(t)} onChange={(value) => setFilter((current) => ({ ...current, triggerSource: value === "__all__" ? "" : String(value), page: 1 }))} />
      <span className={styles.toolbarSpacer} />
      <div className={styles.toolbarActions}>
        <Button className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`} type="tertiary" theme="outline" icon={<IconDelete />} loading={cleanup.isPending} onClick={confirmCleanup}>{t("清理日志")}</Button>
      </div>
    </section>
    <section className={styles.tableCard}>
      <div className={`${styles.grid} ${styles.head}`}><span>{t("创建时间")}</span><span>{t("任务")}</span><span>{t("触发方式")}</span><span>{t("进度")}</span><span>{t("总耗时")}</span><span>{t("状态")}</span></div>
      <div className={styles.body}>
        {tasks.isLoading ? Array.from({ length: DEFAULT_BACKGROUND_JOBS_FILTER.pageSize }, (_, index) => <SkeletonRow key={index} />) : null}
        {tasks.isError ? <div className={styles.state}><strong>{t("任务日志加载失败")}</strong><span>{tasks.error.message}</span><Button type="tertiary" theme="outline" onClick={() => void tasks.refetch()}>{t("重试")}</Button></div> : null}
        {!tasks.isLoading && !tasks.isError && !tasks.data?.rows.length ? <div className={styles.state}><strong>{t("暂无任务日志")}</strong><span>{t("后台任务运行后，处理进度和结果会出现在这里。")}</span></div> : null}
        {tasks.data?.rows.map((job) => <button type="button" key={job.id} className={`${styles.grid} ${styles.row}`} onClick={() => setSelected(job.id)}><span>{formatTimestamp(job.createdAt, language)}</span><span className={styles.task}><strong>{job.title}</strong><small>{job.stage ?? "—"}</small></span><span>{triggerLabel(job.triggerSource, t)}</span><span>{job.progressTotal > 0 ? `${job.progressCurrent}/${job.progressTotal}` : "—"}</span><span className={styles.duration}>{formatJobDuration(job, now, language)}</span><span><StatusTag job={job} t={t} /></span></button>)}
      </div>
      <footer className={styles.footer}><Text type="tertiary" size="small">{t("共 {count} 条", { count: tasks.data?.total ?? 0 })}</Text><Pagination total={tasks.data?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(page) => setFilter((current) => ({ ...current, page }))} /></footer>
    </section>
    <TaskDetail jobId={selected} onClose={() => setSelected(null)} />
  </main>;
}

function TaskDetail({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const { language, t } = useAppPreferences();
  const detail = useBackgroundTaskDetail(jobId);
  const cancel = useCancelBackgroundTask();
  const metrics = useMemo(() => parseSummary(detail.data?.job.summaryJson), [detail.data?.job.summaryJson]);
  const cancelTask = async () => {
    if (!detail.data) return;
    try {
      await cancel.mutateAsync(detail.data.job.id);
    } catch (error) {
      Toast.error(t("任务操作失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const sideTitle = <div className={styles.sideTitle}><strong>{detail.data?.job.title ?? t("任务详情")}</strong><span>{detail.data ? `${triggerLabel(detail.data.job.triggerSource, t)} · ${formatTimestamp(detail.data.job.createdAt, language)}` : t("后台任务")}</span></div>;
  return <SideSheet title={sideTitle} visible={Boolean(jobId)} onCancel={onClose} width="min(680px, 96vw)" bodyStyle={{ padding: 0 }} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={detail.data?.job.status === "running" ? <Button type="danger" loading={cancel.isPending} disabled={detail.data.job.cancelRequested} onClick={() => void cancelTask()}>{detail.data.job.cancelRequested ? t("正在取消…") : t("取消任务")}</Button> : null}>
    {detail.isLoading ? <div className={styles.state}>{t("正在加载任务详情…")}</div> : null}
    {detail.data ? <div className={styles.detail}>
      <section><div className={styles.detailTitle}><strong>{detail.data.job.title}</strong><StatusTag job={detail.data.job} t={t} /></div><p>{detail.data.job.stage ?? "—"}</p><Progress percent={detail.data.job.progressTotal ? Math.round(detail.data.job.progressCurrent / detail.data.job.progressTotal * 100) : 0} showInfo /></section>
      {metrics ? <section><h4>{t("性能指标")}</h4><div className={styles.metrics}>{metric(t("总耗时"), metrics.durationMs)}{metric(t("账号数量"), metrics.accounts, false)}{metric(t("同步成功"), metrics.syncedAccounts, false)}{metric(t("失效账号"), metrics.staleAccounts, false)}{metric(t("失败账号"), metrics.failedAccounts, false)}{metric(t("目录扫描"), metrics.scanMs)}{metric(t("指纹比较"), metrics.compareMs)}{metric(t("会话解析"), metrics.parseMs)}{metric(t("数据库写入"), metrics.writeMs)}{metric(t("增量会话"), metrics.incrementalSessions, false)}{metric(t("全量会话"), metrics.fullSessions, false)}{metrics.sourceBytesProcessed != null ? metricText(t("读取数据"), formatBytes(metrics.sourceBytesProcessed)) : null}{metric(t("延后处理"), metrics.deferred, false)}</div></section> : null}
      {detail.data.job.errorMessage ? <section className={styles.error}>{detail.data.job.errorMessage}</section> : null}
      <section><h4>{t("处理记录")}</h4><div className={styles.timeline}>{detail.data.events.map((event) => <article key={event.id}><i className={styles[event.level] ?? ""} /><div><strong>{event.stage ?? t("处理")}</strong><time>{formatTimestamp(event.createdAt, language)}</time><p>{event.message}</p></div></article>)}</div></section>
    </div> : null}
  </SideSheet>;
}

type SummaryMetrics = { durationMs?: number; accounts?: number; syncedAccounts?: number; staleAccounts?: number; failedAccounts?: number; scanMs?: number; compareMs?: number; parseMs?: number; writeMs?: number; deferred?: number; incrementalSessions?: number; fullSessions?: number; sourceBytesProcessed?: number };
function parseSummary(value: string | null | undefined): SummaryMetrics | null { if (!value) return null; try { return JSON.parse(value) as SummaryMetrics; } catch { return null; } }
function metric(label: string, value: number | undefined, milliseconds = true) { if (value == null) return null; return <span><small>{label}</small><strong>{milliseconds ? `${value} ms` : value}</strong></span>; }
function metricText(label: string, value: string) { return <span><small>{label}</small><strong>{value}</strong></span>; }
function formatBytes(value: number | undefined) { if (value == null) return "—"; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function useElapsedNow(enabled: boolean) { const [now, setNow] = useState(Date.now); useEffect(() => { if (!enabled) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [enabled]); return now; }
function statusOptions(t: Translate) { return [{ value: "__all__", label: t("全部状态") }, { value: "running", label: t("运行中") }, { value: "succeeded", label: t("成功") }, { value: "succeeded_with_warnings", label: t("部分失败") }, { value: "failed", label: t("失败") }, { value: "cancelled", label: t("已取消") }, { value: "interrupted", label: t("已中断") }]; }
function triggerOptions(t: Translate) { return [{ value: "__all__", label: t("全部触发方式") }, { value: "manual", label: t("手动") }, { value: "background", label: t("后台自动") }, { value: "file-watch", label: t("文件变化") }, { value: "foreground", label: t("前台自动") }]; }
function SkeletonRow() { return <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>; }
function StatusTag({ job, t }: { job: BackgroundJobRow; t: Translate }) { const map: Record<string, [string, "green" | "blue" | "orange" | "red" | "grey"]> = { running: ["运行中", "blue"], succeeded: ["成功", "green"], succeeded_with_warnings: ["部分失败", "orange"], failed: ["失败", "red"], cancelled: ["已取消", "grey"], interrupted: ["已中断", "grey"], queued: ["等待中", "grey"] }; const [label, color] = map[job.status] ?? [job.status, "grey"]; return <Tag size="small" color={color}>{t(label)}</Tag>; }
function triggerLabel(value: string, t: Translate) { return t(value === "manual" ? "手动" : value === "background" ? "后台自动" : value === "file-watch" ? "文件变化" : "前台自动"); }
