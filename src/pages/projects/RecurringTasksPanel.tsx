import { useEffect, useState } from "react";
import { Button, Empty, Input, Modal, Select, SideSheet, Switch, Tag, Toast } from "@douyinfe/semi-ui-19";
import { IconDelete, IconEdit, IconPlus, IconPlay } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { Project, RecurringTask, RecurringTaskRun } from "../../domains/project/types";
import { useBackgroundTaskDetail } from "../../features/background-tasks/useBackgroundTasks";
import { useAgentCapabilities } from "../../features/agent-access/useAgentEnvironment";
import { useRecurringTaskActions, useRecurringTaskRuns, useRecurringTasks } from "../../features/projects/useProjects";
import { errorMessage } from "../../shared/errors/AppError";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { Markdown } from "../../shared/ui/Markdown";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { ProjectTaskEditorFields } from "./ProjectTaskEditorFields";
import styles from "./ProjectsPage.module.css";

export function RecurringTasksPanel({ project, autoRefresh }: { project: Project; autoRefresh: boolean }) {
  const { language, t } = useAppPreferences();
  const tasks = useRecurringTasks(project.id, autoRefresh);
  const actions = useRecurringTaskActions(project.id);
  const agentCapabilities = useAgentCapabilities();
  const [editing, setEditing] = useState<RecurringTask | "new" | null>(null);
  const [viewing, setViewing] = useState<RecurringTask | null>(null);
  const [selectedRun, setSelectedRun] = useState<RecurringTaskRun | null>(null);
  const runs = useRecurringTaskRuns(viewing?.id ?? null, autoRefresh);
  const detail = useBackgroundTaskDetail(selectedRun?.jobId ?? null);
  const [draft, setDraft] = useState(() => newRecurringTask(project.id));
  const selectedAgentCapability = agentCapabilities.data?.agents.find((agent) => agent.task.profile === draft.agentProfile);
  const resumeDisabledReason = selectedAgentCapability && !selectedAgentCapability.task.supportsResume
    ? selectedAgentCapability.task.resumeUnsupportedMessage
    : null;

  useEffect(() => {
    if (!resumeDisabledReason) return;
    setDraft((current) => current.sessionPolicy === "continue"
      ? { ...current, sessionPolicy: "fresh" }
      : current);
  }, [resumeDisabledReason]);

  const openEditor = (task: RecurringTask | "new") => { setEditing(task); setDraft(task === "new" ? newRecurringTask(project.id) : { ...task }); };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    try { await actions.save.mutateAsync({ ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() }); setEditing(null); Toast.success(t("重复任务已保存")); }
    catch (error) { Toast.error(errorMessage(error)); }
  };
  const runNow = async (task: RecurringTask, test = false) => {
    try { const result = await actions.run.mutateAsync({ taskId: task.id, test }); Toast.success(result.started ? t(test ? "测试运行已开始" : "任务运行已开始") : result.message); }
    catch (error) { Toast.error(errorMessage(error)); }
  };
  if (tasks.isLoading) return <div className={styles.state}>{t("正在读取重复任务…")}</div>;
  return <div className={styles.recurringView}>
    <div className={styles.recurringToolbar}><div><strong>{t("重复任务")}</strong><span>{t("每次运行产生独立结果；同一次中断恢复才复用会话。")}</span></div><Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => openEditor("new")}>{t("新建重复任务")}</Button></div>
    {tasks.data?.length ? <div className={styles.recurringList}>{tasks.data.map((task) => <article key={task.id} className={styles.recurringCard}>
      <button className={styles.recurringMain} onClick={() => setViewing(task)}><span><strong>{task.title}</strong><small>{task.scheduleKind === "daily" ? t("每天 {time} · {timezone}", { time: task.dailyTime ?? "--:--", timezone: task.timezone }) : t("仅手动运行")}</small></span><span className={styles.recurringMeta}>{task.enabled ? <Tag color="green">{t("已启用")}</Tag> : <Tag>{t("已暂停")}</Tag>}<small>{task.nextRunAt ? t("下次 {time}", { time: formatTimestamp(task.nextRunAt, language) }) : t("无自动计划")}</small></span></button>
      <div className={styles.recurringActions}><Button theme="borderless" icon={<IconPlay />} onClick={() => void runNow(task)}>{t("立即运行")}</Button><Button theme="borderless" icon={<IconEdit />} onClick={() => openEditor(task)}>{t("编辑")}</Button><Button theme="borderless" type="danger" icon={<IconDelete />} onClick={() => Modal.confirm({ title: t("删除重复任务“{name}”？", { name: task.title }), content: t("历史运行结果也会一并删除。"), okType: "danger", okText: t("删除"), cancelText: t("取消"), zIndex: APP_OVERLAY_Z_INDEX.modal, onOk: () => actions.remove.mutateAsync(task.id) })} /></div>
    </article>)}</div> : (
      <Empty
        title={t("还没有重复任务")}
        description={t("可以手动多次运行，或每天在指定时间自动生成一份独立结果。")}
      />
    )}

    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建重复任务") : t("编辑重复任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span/><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button onClick={() => void runNow(draft, true)} disabled={editing === "new"}>{t("测试运行")}</Button><Button type="primary" theme="solid" loading={actions.save.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}>
        <ProjectTaskEditorFields value={draft} onChange={(patch) => setDraft((current) => {
          const next = { ...current, ...patch };
          const capability = agentCapabilities.data?.agents.find((agent) => agent.task.profile === next.agentProfile);
          return capability && !capability.task.supportsResume && next.sessionPolicy === "continue"
            ? { ...next, sessionPolicy: "fresh" }
            : next;
        })} descriptionOptional={false} />
        <div className={styles.formGrid}>
          <label><span>{t("运行方式")}</span><Select value={draft.scheduleKind} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={[{value:"manual",label:t("手动多次运行")},{value:"daily",label:t("每天定时运行")}]} onChange={(value) => setDraft((current) => ({...current,scheduleKind:String(value) as "manual"|"daily",enabled:value === "daily" ? current.enabled : false}))}/></label>
          <label><span>{t("会话策略")}</span><Select value={draft.sessionPolicy} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={[{value:"fresh",label:t("每次新建会话（推荐）")},{value:"continue",label:t("延续上次成功会话"),disabled:Boolean(resumeDisabledReason)}]} onChange={(value) => setDraft((current) => ({...current,sessionPolicy:String(value) as "fresh"|"continue"}))}/><small>{resumeDisabledReason ?? t("中断恢复始终继续同一次运行的会话。")}</small></label>
        </div>
        {draft.scheduleKind === "daily" ? <><div className={styles.formGrid}><label><span>{t("每日时间")}</span><Input value={draft.dailyTime ?? "09:00"} placeholder="09:00" onChange={(dailyTime) => setDraft((current) => ({...current,dailyTime}))}/></label><span/></div><label className={styles.switchRow}><span><strong>{t("启用自动运行")}</strong><small>{t("Flowlet 在托盘运行且电脑处于唤醒状态时生效。")}</small></span><Switch checked={draft.enabled} onChange={(enabled) => setDraft((current) => ({...current,enabled}))}/></label></> : null}
      </div>
    </SideSheet>

    <SideSheet visible={viewing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={viewing?.title ?? t("运行结果")} onCancel={() => { setViewing(null); setSelectedRun(null); }} zIndex={APP_OVERLAY_Z_INDEX.sideSheet}><div className={styles.runRecordList}>{runs.data?.length ? runs.data.map((run) => <button key={run.id} className={styles.recurringRun} onClick={() => setSelectedRun(run)}><span><strong>{run.triggerSource === "scheduled" ? t("自动运行") : run.triggerSource === "test" ? t("测试运行") : t("手动运行")}</strong><small>{formatTimestamp(run.createdAt, language)}</small></span><Tag color={run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : "blue"}>{run.status}</Tag></button>) : <Empty title={t("暂无运行结果")}/>}</div></SideSheet>
    <SideSheet visible={selectedRun != null} width={DETAIL_SHEET_WIDTH} motion={false} title={t("运行输出")} onCancel={() => setSelectedRun(null)} zIndex={APP_OVERLAY_Z_INDEX.modal}><div className={styles.runOutput}>{selectedRun?.sessionId ? <div className={styles.formNote}>{t("Agent 会话：{id}", { id: selectedRun.sessionId })}</div> : null}{selectedRun?.errorMessage ? <div className={styles.readonlyJobError}>{selectedRun.errorMessage}</div> : null}{detail.data?.events.map((event) => <section key={event.id}><small>{event.stage ?? event.level} · {formatTimestamp(event.createdAt, language)}</small><Markdown content={event.message} /></section>) ?? <div className={styles.state}>{t("正在读取输出…")}</div>}</div></SideSheet>
  </div>;
}

function newRecurringTask(projectId: string): RecurringTask { const now = new Date().toISOString(); return { id: crypto.randomUUID(), projectId, title: "", description: "", taskType: "readonly", agentProfile: "Claude Code", scheduleKind: "manual", dailyTime: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", enabled: false, sessionPolicy: "fresh", sourceTaskId: null, nextRunAt: null, lastScheduledFor: null, createdAt: now, updatedAt: now }; }
