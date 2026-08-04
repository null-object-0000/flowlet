import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Popconfirm, Progress, Select, SideSheet, Tabs, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { IconDelete, IconEdit, IconExternalOpen, IconFolder, IconPlus } from "@douyinfe/semi-icons";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import { projectCommands } from "../../domains/project/commands";
import type { Project, ProjectTask, ProjectTaskMutableStatus, ProjectTaskPriority, ProjectTaskRunnerState, ProjectTaskStatus, ProjectTaskType, TaskExecutionRecord } from "../../domains/project/types";
import { parseTaskExecutionHistory } from "../../domains/project/types";
import { useBackgroundTaskDetail } from "../../features/background-tasks/useBackgroundTasks";
import { newProject, newProjectTask, useProject, useProjectActions, useProjects, useProjectTaskActions, useProjectTaskRunnerActions, useProjectTaskScheduler, useProjectTasks } from "../../features/projects/useProjects";
import { errorMessage } from "../../shared/errors/AppError";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import styles from "./ProjectsPage.module.css";

export function ProjectsPage() {
  const { projectId } = useParams();
  return projectId ? <ProjectDetail projectId={projectId} /> : <ProjectList />;
}

function ProjectList() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const projects = useProjects();
  const actions = useProjectActions();
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [draft, setDraft] = useState({ name: "", directoryPath: "" });

  const openEditor = (project: Project | "new") => {
    setEditing(project);
    setDraft(project === "new" ? { name: "", directoryPath: "" } : { name: project.name, directoryPath: project.directoryPath });
  };
  const chooseDirectory = async () => {
    const path = await open({ directory: true, multiple: false, title: t("选择项目目录") });
    if (typeof path !== "string") return;
    setDraft((current) => ({ ...current, directoryPath: path }));
    if (!draft.name.trim()) {
      const segments = path.split(/[\\/]/).filter(Boolean);
      setDraft({ name: segments[segments.length - 1] ?? t("新项目"), directoryPath: path });
    }
  };
  const save = async () => {
    if (!editing || !draft.name.trim() || !draft.directoryPath) return;
    const now = new Date().toISOString();
    const project = editing === "new"
      ? newProject(draft.name, draft.directoryPath)
      : { ...editing, name: draft.name.trim(), directoryPath: draft.directoryPath, updatedAt: now };
    try {
      await actions.saveProject.mutateAsync(project);
      Toast.success(editing === "new" ? t("项目已创建") : t("项目已更新"));
      setEditing(null);
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  const remove = (project: Project) => Modal.confirm({
    title: t("删除项目“{name}”？", { name: project.name }),
    content: t("只会删除 Flowlet 中的项目和本地任务，不会删除目录或 Agent 会话。"),
    zIndex: APP_OVERLAY_Z_INDEX.modal,
    okType: "danger",
    okText: t("删除"),
    cancelText: t("取消"),
    onOk: async () => {
      await actions.deleteProject.mutateAsync(project.id);
      Toast.success(t("项目已删除"));
    },
  });

  return <main className={styles.page}>
    <PageHeader title={t("项目管理")} subtitle={t("用目录组织 Agent 会话，并管理项目内的本地任务")}>
      <Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => openEditor("new")}>{t("新建项目")}</Button>
    </PageHeader>
    {projects.isLoading ? <div className={styles.state}>{t("正在读取项目…")}</div> : null}
    {projects.isError ? <div className={styles.state}><strong>{t("项目加载失败")}</strong><span>{projects.error.message}</span><Button onClick={() => void projects.refetch()}>{t("重试")}</Button></div> : null}
    {!projects.isLoading && !projects.isError && projects.data?.length === 0 ? <div className={styles.empty}><Empty title={t("还没有项目")} description={t("创建一个项目并绑定本机目录，相关 Agent 会话会自动归入项目看板。")}/><Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => openEditor("new")}>{t("创建第一个项目")}</Button></div> : null}
    <section className={styles.projectGrid}>
      {projects.data?.map((project) => <article key={project.id} className={styles.projectCard} onClick={() => navigate(`/projects/${project.id}`)}>
        <div className={styles.projectIcon}><IconFolder /></div>
        <div className={styles.projectCopy}><strong>{project.name}</strong><span title={project.directoryPath}>{project.directoryPath}</span><small>{t("更新于 {time}", { time: formatTimestamp(project.updatedAt, language) })}</small></div>
        <div className={styles.cardActions}>
          <Button theme="borderless" icon={<IconEdit />} aria-label={t("编辑项目")} onClick={(event) => { event.stopPropagation(); openEditor(project); }} />
          <Button theme="borderless" type="danger" icon={<IconDelete />} aria-label={t("删除项目")} onClick={(event) => { event.stopPropagation(); remove(project); }} />
        </div>
      </article>)}
    </section>
    <Modal title={editing === "new" ? t("新建项目") : t("编辑项目")} visible={editing != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("保存")} cancelText={t("取消")} onCancel={() => setEditing(null)} onOk={() => void save()} okButtonProps={{ loading: actions.saveProject.isPending, disabled: !draft.name.trim() || !draft.directoryPath }}>
      <div className={styles.form}>
        <label><span>{t("项目名称")}</span><Input autoFocus value={draft.name} maxLength={80} placeholder={t("例如：Flowlet 桌面端")} onChange={(name) => setDraft((current) => ({ ...current, name }))} /></label>
        <label><span>{t("项目目录")}</span><div className={styles.pathInput}><Input value={draft.directoryPath} readonly placeholder={t("选择一个本机目录")} /><Button icon={<IconFolder />} onClick={() => void chooseDirectory()}>{t("选择目录")}</Button></div><small>{t("第一版每个项目绑定一个目录；目录本身不会被 Flowlet 修改。")}</small></label>
      </div>
    </Modal>
  </main>;
}

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { t } = useAppPreferences();
  const navigate = useNavigate();
  const project = useProject(projectId);
  if (project.isLoading) return <main className={styles.page}><div className={styles.state}>{t("正在读取项目…")}</div></main>;
  if (project.isError || !project.data) return <main className={styles.page}><div className={styles.state}><strong>{t("项目不存在或加载失败")}</strong><Button onClick={() => navigate("/projects")}>{t("返回项目列表")}</Button></div></main>;
  return <LoadedProjectDetail project={project.data} />;
}

function LoadedProjectDetail({ project }: { project: Project }) {
  const { language, t } = useAppPreferences();
  const location = useLocation();
  const refresh = useRefreshControl({ intervalMs: 15_000 });
  const tasks = useProjectTasks(project.id, refresh.autoRefresh);
  // 前端调度器：进入项目详情页即自动轮询「槽空闲 && 有待处理任务」，有空闲就领取执行。
  const scheduler = useProjectTaskScheduler(refresh.autoRefresh);
  // 独立窗口（#/project-window/...）里不再显示「打开独立窗口」按钮。
  const isStandaloneWindow = location.pathname.startsWith("/project-window");
  const openDetailWindow = async () => {
    try {
      await projectCommands.openDetailWindow(project.id);
    } catch (error) {
      Toast.error(errorMessage(error));
    }
  };
  return <main className={styles.page}>
    <PageHeader title={project.name} subtitle={project.directoryPath}>
      {isStandaloneWindow ? null : (
        <Button
          theme="borderless"
          type="tertiary"
          icon={<IconExternalOpen />}
          aria-label={t("在独立窗口打开")}
          title={t("在独立窗口打开此项目看板，可同时操作主窗口")}
          onClick={() => void openDetailWindow()}
        />
      )}
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={tasks.isFetching || scheduler.runnerState.isFetching}
        lastUpdatedAt={Math.max(tasks.dataUpdatedAt, scheduler.runnerState.dataUpdatedAt)}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void tasks.refetch()}
        language={language}
        t={t}
      />
    </PageHeader>
    <section className={styles.detailContent}>
      <TaskBoard project={project} tasks={tasks} runnerState={scheduler.runnerState.data} />
    </section>
  </main>;
}

const TASK_COLUMNS: Array<{ id: string; statuses: ProjectTaskStatus[]; label: string; addable?: boolean }> = [
  { id: "backlog", statuses: ["draft", "submitted"], label: "待处理", addable: true },
  { id: "in_progress", statuses: ["in_progress"], label: "进行中" },
  { id: "review", statuses: ["review"], label: "待审核" },
];

const TASK_TYPES: Array<{ value: ProjectTaskType; label: string }> = [
  { value: "code", label: "代码修改" },
  { value: "readonly", label: "只读分析" },
];

const AGENT_PROFILES = ["Claude Code", "OpenCode", "Pi"];

const PRIORITIES: Array<{ value: ProjectTaskPriority; label: string; description: string }> = [
  { value: "p0", label: "P0", description: "紧急" },
  { value: "p1", label: "P1", description: "高" },
  { value: "p2", label: "P2", description: "普通" },
];

function TaskBoard({ project, tasks, runnerState }: { project: Project; tasks: ReturnType<typeof useProjectTasks>; runnerState?: ProjectTaskRunnerState }) {
  const { t } = useAppPreferences();
  const actions = useProjectTaskActions(project.id);
  const runnerActions = useProjectTaskRunnerActions();
  const [editing, setEditing] = useState<ProjectTask | "new" | null>(null);
  const [viewing, setViewing] = useState<ProjectTask | null>(null);
  const [rejecting, setRejecting] = useState<ProjectTask | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [draft, setDraft] = useState({ title: "", description: "", taskType: "code" as ProjectTaskType, agentProfile: "Claude Code", priority: "p2" as ProjectTaskPriority });
  const [runningLogs, setRunningLogs] = useState<Record<string, string>>({});
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, tasks.data?.filter((task) => column.statuses.includes(task.status)) ?? []])) as Record<string, ProjectTask[]>, [tasks.data]);
  const openEditor = (task: ProjectTask | "new") => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", taskType: "code", agentProfile: "Claude Code", priority: "p2" } : { title: task.title, description: task.description, taskType: task.taskType, agentProfile: task.agentProfile, priority: task.priority }); };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    const task = editing === "new" ? { ...newProjectTask(project.id, draft.title), description: draft.description.trim(), taskType: draft.taskType, agentProfile: draft.agentProfile, priority: draft.priority } : { ...editing, ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() };
    try { await actions.saveTask.mutateAsync(task); Toast.success(t("任务已保存")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 提交 / 撤回仅在草稿与已提交之间流转（in_progress 由执行器管理，review 由审核管理）。
  const toggleSubmitted = async (task: ProjectTask, submitted: boolean) => { try { await actions.saveTask.mutateAsync({ ...task, status: submitted ? "submitted" : "draft", updatedAt: new Date().toISOString() }); } catch (error) { Toast.error(errorMessage(error)); } };
  const removeEditingTask = async () => {
    if (!editing || editing === "new") return;
    try { await actions.deleteTask.mutateAsync(editing.id); Toast.success(t("任务已删除")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 审核推进：批准 → done（直接）；退回 → 弹原因 Modal → submitted 重新排队。
  const approveTask = async (task: ProjectTask) => {
    try {
      await runnerActions.setTaskStatus.mutateAsync({ taskId: task.id, status: "done" });
      setViewing(null);
      Toast.success(t("任务已通过审核"));
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  const openReject = (task: ProjectTask) => { setRejecting(task); setRejectReason(""); };
  const rejectTask = async () => {
    if (!rejecting) return;
    try {
      await runnerActions.setTaskStatus.mutateAsync({ taskId: rejecting.id, status: "submitted", reason: rejectReason.trim() });
      setRejecting(null);
      setViewing(null);
      Toast.success(t("任务已退回重新排队"));
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  const cancelRunning = async (jobId: string) => {
    try { await backgroundTaskCommands.cancel(jobId); Toast.info(t("已请求取消执行")); } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 订阅执行实时日志：Agent 输出逐条追加到对应进行中任务卡片。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ projectId: string; taskId: string; text: string }>("project-task-log", (event) => {
      if (event.payload.projectId !== project.id) return;
      const taskId = event.payload.taskId;
      setRunningLogs((current) => ({ ...current, [taskId]: `${current[taskId] ?? ""}${event.payload.text}` }));
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [project.id]);

  const renderCardFooter = (task: ProjectTask) => {
    switch (task.status) {
      case "draft":
        return <button className={`${styles.taskCardAction} ${styles.taskCardSubmit}`} onClick={() => void toggleSubmitted(task, true)}>{t("提交")}</button>;
      case "submitted":
        return <button className={`${styles.taskCardAction} ${styles.taskCardWithdraw}`} onClick={() => void toggleSubmitted(task, false)}>{t("撤回")}</button>;
      case "in_progress": {
        if (runnerState?.current?.taskId !== task.id) return null;
        return <button className={`${styles.taskCardAction} ${styles.taskCardCancel}`} onClick={() => void cancelRunning(runnerState.current!.jobId)}>{t("取消执行")}</button>;
      }
      case "review":
        return <div className={styles.taskReviewActions}><Button size="small" onClick={() => openReject(task)}>{t("退回")}</Button><Button size="small" type="primary" theme="solid" onClick={() => void approveTask(task)}>{t("批准")}</Button></div>;
      default:
        return null;
    }
  };

  return <div className={styles.boardView}>
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : <div className={`${styles.board} ${styles.taskBoard}`}>
      {TASK_COLUMNS.map((column) => <section className={styles.column} key={column.id}><header><span className={styles.colTitle}><span>{t(column.label)}</span><span className={styles.colCount}>{grouped[column.id].length}</span></span>{column.addable ? <button className={styles.addColButton} aria-label={t("添加任务")} title={t("添加任务")} onClick={() => openEditor("new")}><IconPlus /></button> : null}</header><div className={styles.columnBody}>
        {grouped[column.id].map((task) => <article className={styles.taskCard} key={task.id}><div className={styles.taskTags}><span className={`${styles.taskTag} ${styles.taskTagPriority}`}>{t(priorityLabel(task.priority))}</span><span className={statusTagClass(task.status)}>{t(statusTagLabel(task.status))}</span><span className={`${styles.taskTag} ${styles.taskTagType}`}>{t(taskTypeLabel(task.taskType))}</span><span className={`${styles.taskTag} ${styles.taskTagAgent}`}>{task.agentProfile}</span></div><div className={styles.taskTitle}>{task.status === "draft" ? <button className={styles.taskTitleLink} title={t("编辑任务")} onClick={() => openEditor(task)}><strong>{task.title}</strong></button> : <button className={styles.taskTitleLink} title={t("查看任务详情")} onClick={() => setViewing(task)}><strong>{task.title}</strong></button>}</div>{renderCardFooter(task)}{task.status === "in_progress" && runningLogs[task.id] ? <div className={styles.taskLogBlock}>{runningLogs[task.id]}</div> : null}</article>)}
        {column.addable ? <button className={styles.addCard} onClick={() => openEditor("new")}><IconPlus />{t("添加任务")}</button> : null}
      </div></section>)}
    </div>}
    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建任务") : t("编辑任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span>{editing !== "new" && editing ? <Popconfirm className={styles.taskDeletePopconfirm} title={t("删除任务“{name}”？", { name: editing.title })} okText={t("删除")} cancelText={t("取消")} okType="danger" onConfirm={() => void removeEditingTask()}><Button type="danger" theme="borderless" icon={<IconDelete />}>{t("删除")}</Button></Popconfirm> : null}</span><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button type="primary" theme="solid" loading={actions.saveTask.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}><div className={styles.formRow}><label><span>{t("优先级")}</span><Select value={draft.priority} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} renderSelectedItem={(optionNode: { value?: string | number }) => String(optionNode.value ?? "").toUpperCase()} optionList={PRIORITIES.map((item) => ({ value: item.value, label: `${t(item.label)} · ${t(item.description)}` }))} onChange={(value) => setDraft((current) => ({ ...current, priority: String(value) as ProjectTaskPriority }))} /></label><label><span>{t("任务标题")}</span><Input autoFocus value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /></label></div><label><span>{t("任务描述（可选）")}</span><TextArea value={draft.description} autosize={{ minRows: 3, maxRows: 6 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><div className={styles.formGrid}><label><span>{t("任务类型")}</span><Select value={draft.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, taskType: String(value) as ProjectTaskType }))} /></label><label><span>{t("Agent Profile")}</span><Select value={draft.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} onChange={(value) => setDraft((current) => ({ ...current, agentProfile: String(value) }))} /></label></div></div>
    </SideSheet>
    <TaskReadonlySideSheet task={viewing} onClose={() => setViewing(null)} onApprove={(task) => void approveTask(task)} onReject={(task) => openReject(task)} />
    <Modal title={t("退回任务")} visible={rejecting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("退回")} cancelText={t("取消")} okType="danger" onCancel={() => setRejecting(null)} onOk={() => void rejectTask()} okButtonProps={{ loading: runnerActions.setTaskStatus.isPending, disabled: !rejectReason.trim() }}>
      <div className={styles.form}><label><span>{t("退回原因（必填）")}</span><TextArea value={rejectReason} autosize={{ minRows: 3, maxRows: 6 }} placeholder={t("说明哪里不符合预期，Agent 将据此修正后重新执行")} onChange={(value) => setRejectReason(value)} /></label></div>
    </Modal>
  </div>;
}

function taskTypeLabel(taskType: ProjectTaskType) { return taskType === "code" ? "代码修改" : "只读分析"; }

function priorityLabel(priority: ProjectTaskPriority) { return priority.toUpperCase(); }

function statusTagLabel(status: ProjectTaskStatus) {
  switch (status) {
    case "draft": return "未提交";
    case "submitted": return "已提交";
    case "in_progress": return "执行中";
    case "review": return "待审核";
    case "done": return "已完成";
  }
}

function statusTagClass(status: ProjectTaskStatus) {
  switch (status) {
    case "draft": return styles.taskStatusDraft;
    case "submitted": return styles.taskStatusSubmitted;
    case "in_progress": return styles.taskStatusInProgress;
    case "review": return styles.taskStatusReview;
    case "done": return styles.taskStatusDone;
  }
}

/** 提交后任务的只读详情抽屉：顶部任务信息 + 执行历史（每次执行的 Agent 情况）。 */
function TaskReadonlySideSheet({ task, onClose, onApprove, onReject }: { task: ProjectTask | null; onClose: () => void; onApprove: (task: ProjectTask) => void; onReject: (task: ProjectTask) => void }) {
  const { language, t } = useAppPreferences();
  // 执行历史按时间正序（history[0] 最早），默认选中最近一次。
  const history = useMemo(() => parseTaskExecutionHistory(task?.executionHistory ?? null), [task?.executionHistory]);
  const [activeIndex, setActiveIndex] = useState(history.length > 0 ? history.length - 1 : 0);
  // 切换任务时重置到最近一次执行。
  useEffect(() => { setActiveIndex(history.length > 0 ? history.length - 1 : 0); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isReview = task?.status === "review";
  const footer = (
    <div className={styles.taskSheetFooter}><span></span><span className={styles.taskSheetFooterActions}>
      {isReview && task ? (
        <>
          <Button onClick={() => onReject(task)}>{t("退回")}</Button>
          <Button type="primary" theme="solid" onClick={() => onApprove(task)}>{t("批准")}</Button>
        </>
      ) : null}
      <Button onClick={onClose}>{t("关闭")}</Button>
    </span></div>
  );

  return (
    <SideSheet
      visible={task != null}
      width={DETAIL_SHEET_WIDTH}
      motion={false}
      title={task ? <TaskReadonlyHeader task={task} /> : null}
      onCancel={onClose}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      footer={footer}
    >
      {task ? (
        <div className={styles.readonlyBody}>
          <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("任务信息")}</strong>
            <div className={styles.readonlyGrid}>
              <ReadonlyItem label={t("优先级")} value={task.priority.toUpperCase()} />
              <ReadonlyItem label={t("状态")} value={t(statusTagLabel(task.status))} />
              <ReadonlyItem label={t("任务类型")} value={t(taskTypeLabel(task.taskType))} />
              <ReadonlyItem label={t("Agent Profile")} value={task.agentProfile} />
              <ReadonlyItem label={t("创建时间")} value={formatTimestamp(task.createdAt, language)} />
              <ReadonlyItem label={t("更新时间")} value={formatTimestamp(task.updatedAt, language)} />
              <ReadonlyItem label={t("任务描述")} value={task.description.trim() || t("无描述")} wide />
            </div>
          </section>
          <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("Agent 执行情况")}</strong>
            {history.length === 0 ? <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无 Agent 执行记录")}</div> : (
              <Tabs type="line" activeKey={String(activeIndex)} onChange={(key) => setActiveIndex(Number(key))}>
                {history.map((record, index) => (
                  <Tabs.TabPane tab={executionTabLabel(index, record, t)} itemKey={String(index)} key={record.jobId}>
                    <JobExecutionView jobId={record.jobId} record={record} />
                  </Tabs.TabPane>
                ))}
              </Tabs>
            )}
          </section>
        </div>
      ) : null}
    </SideSheet>
  );
}

function executionTabLabel(index: number, record: TaskExecutionRecord, t: (key: string, params?: Record<string, string | number>) => string) {
  const base = t("第 {n} 次执行", { n: index + 1 });
  return <span className={styles.readonlyTabLabel}>{base}{record.rejected ? <span className={styles.readonlyTabRejected}>{t("已退回")}</span> : null}</span>;
}

/** 单次执行的详情：job 状态 + 进度 + 事件流（含退回原因 timeline 事件）。 */
function JobExecutionView({ jobId, record }: { jobId: string; record: TaskExecutionRecord }) {
  const { language, t } = useAppPreferences();
  const detail = useBackgroundTaskDetail(jobId);
  const job = detail.data?.job;
  return (
    <div className={styles.readonlyJob}>
      {record.rejected && record.rejectionReason ? (
        <div className={styles.readonlyRejected}>
          <strong>{t("已退回：{reason}", { reason: record.rejectionReason })}</strong>
          {record.rejectedAt ? <time>{formatTimestamp(record.rejectedAt, language)}</time> : null}
        </div>
      ) : null}
      {detail.isLoading ? <div className={styles.readonlyEmpty}>{t("正在读取执行记录…")}</div> : null}
      {detail.isError ? <div className={styles.readonlyEmpty}>{t("执行记录读取失败：{message}", { message: detail.error.message })}</div> : null}
      {!detail.isLoading && !detail.isError && !job ? <div className={styles.readonlyEmpty}>{t("执行记录已清理或不可用")}</div> : null}
      {job ? (
        <>
          <div className={styles.readonlyJobHead}><strong>{job.title}</strong><JobStatusTag status={job.status} t={t} /></div>
          {job.stage ? <p className={styles.readonlyJobStage}>{job.stage}</p> : null}
          {job.progressTotal > 0 ? <Progress percent={Math.round(job.progressCurrent / job.progressTotal * 100)} showInfo size="small" /> : null}
          {job.errorMessage ? <div className={styles.readonlyJobError}>{job.errorMessage}</div> : null}
          <div className={styles.readonlyTimeline}>
            {detail.data?.events.map((event) => (
              <article key={event.id}>
                <i className={styles[`readonlyLevel${capLevel(event.level)}`] ?? ""} />
                <div><strong>{event.stage ?? t("处理")}</strong><time>{formatTimestamp(event.createdAt, language)}</time><p>{event.message}</p></div>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TaskReadonlyHeader({ task }: { task: ProjectTask }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.readonlyHeader}>
      <div className={styles.readonlyHeaderTopline}>
        <span className={styles.readonlyHeaderBadge}>{task.agentProfile}</span>
        <strong className={styles.readonlyHeaderTitle} title={task.title}>{task.title}</strong>
      </div>
      <div className={styles.readonlyHeaderMeta}><span className={statusTagClass(task.status)}>{t(statusTagLabel(task.status))}</span><span>{t("优先级 {priority}", { priority: task.priority.toUpperCase() })}</span><span>{t("任务类型：{type}", { type: t(taskTypeLabel(task.taskType)) })}</span></div>
    </div>
  );
}

function ReadonlyItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`${styles.readonlyItem} ${wide ? styles.readonlyItemWide : ""}`}><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function JobStatusTag({ status, t }: { status: string; t: (key: string) => string }) {
  const map: Record<string, [string, "green" | "blue" | "orange" | "red" | "grey"]> = {
    running: ["运行中", "blue"],
    succeeded: ["成功", "green"],
    succeeded_with_warnings: ["部分失败", "orange"],
    failed: ["失败", "red"],
    cancelled: ["已取消", "grey"],
    interrupted: ["已中断", "grey"],
    queued: ["等待中", "grey"],
  };
  const [label, color] = map[status] ?? [status, "grey"];
  return <Tag size="small" color={color}>{t(label)}</Tag>;
}

function capLevel(level: string) {
  if (!level) return "";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

