import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Empty, Input, Modal, Select, SideSheet, Tabs, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { IconAIEditLevel1, IconChevronRight, IconCopy, IconDelete, IconEdit, IconExternalOpen, IconFolder, IconMore, IconPlus, IconRefresh, IconStop, IconTickCircle } from "@douyinfe/semi-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import type { BackgroundJobEvent } from "../../domains/background-task/types";
import { projectCommands } from "../../domains/project/commands";
import { MIN_TITLE_GENERATION_DESCRIPTION_LENGTH, canAutoGenerateTaskTitle, generateTaskTitle } from "../../domains/project/generateTaskTitle";
import type { Project, ProjectTask, ProjectTaskMutableStatus, ProjectTaskPriority, ProjectTaskRunnerState, ProjectTaskStatus, ProjectTaskType, TaskExecutionRecord } from "../../domains/project/types";
import { proxyCommands } from "../../domains/proxy/commands";
import { taskExecutionHistory, taskTotalExecutionDuration, taskTotalWaitingDuration, taskWaitingDuration } from "../../domains/project/types";
import { SessionConversation } from "../../features/agent-sessions/SessionConversation";
import { useAgentSessionTimeline } from "../../features/agent-sessions/useAgentSessions";
import { useBackgroundTaskDetail } from "../../features/background-tasks/useBackgroundTasks";
import { newProject, newProjectTask, useProject, useProjectActions, useProjects, useProjectTaskActions, useProjectTaskRunnerActions, useProjectTaskScheduler, useProjectTasks } from "../../features/projects/useProjects";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp, formatTimestamp } from "../../shared/formatters/datetime";
import { queryKeys } from "../../shared/query-keys";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { formatElapsed } from "../task-logs/taskDuration";
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
    setDraft(project === "new" ? { name: "", directoryPath: "" } : { name: project.name, directoryPath: project.directoryPath ?? "" });
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
    if (!editing || !draft.name.trim()) return;
    // 新建项目必须绑定目录；编辑远端项目可先留空（保持未绑定），之后单独绑定。
    if (editing === "new" && !draft.directoryPath.trim()) return;
    const now = new Date().toISOString();
    const project = editing === "new"
      ? newProject(draft.name, draft.directoryPath)
      : { ...editing, name: draft.name.trim(), directoryPath: draft.directoryPath.trim() || null, updatedAt: now };
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
        <div className={styles.projectCopy}><strong>{project.name}</strong><span title={project.directoryPath ?? undefined}>{project.directoryPath ?? t("未绑定目录")}</span><small>{t("更新于 {time}", { time: formatTimestamp(project.updatedAt, language) })}</small></div>
        <div className={styles.cardActions}>
          <Button theme="borderless" icon={<IconEdit />} aria-label={t("编辑项目")} onClick={(event) => { event.stopPropagation(); openEditor(project); }} />
          <Button theme="borderless" type="danger" icon={<IconDelete />} aria-label={t("删除项目")} onClick={(event) => { event.stopPropagation(); remove(project); }} />
        </div>
      </article>)}
    </section>
    <Modal title={editing === "new" ? t("新建项目") : t("编辑项目")} visible={editing != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("保存")} cancelText={t("取消")} onCancel={() => setEditing(null)} onOk={() => void save()} okButtonProps={{ loading: actions.saveProject.isPending, disabled: !draft.name.trim() || (editing === "new" && !draft.directoryPath.trim()) }}>
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
  const navigate = useNavigate();
  const refresh = useRefreshControl({ intervalMs: 15_000 });
  const tasks = useProjectTasks(project.id, refresh.autoRefresh);
  // 前端调度器：进入项目详情页即自动轮询「槽空闲 && 有待处理任务」，有空闲就领取执行。
  const scheduler = useProjectTaskScheduler(refresh.autoRefresh);
  // 独立窗口（#/project-window/...）里不再显示「打开独立窗口」按钮。
  const isStandaloneWindow = location.pathname.startsWith("/project-window");
  const openDetailWindow = async () => {
    try {
      await projectCommands.openDetailWindow(project.id);
      // 项目详情已移交独立窗口展示，主窗口自动回退到项目管理页。
      navigate("/projects");
    } catch (error) {
      Toast.error(errorMessage(error));
    }
  };
  return <main className={styles.page}>
    <PageHeader title={project.name} subtitle={project.directoryPath ?? t("未绑定目录")}>
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
  { id: "done", statuses: ["done"], label: "已完成" },
];

// 任务看板单列最小宽度与列间距（与 .taskBoard 的 minmax(240px, 1fr) 及 gap 保持一致）。
const TASK_COLUMN_MIN_WIDTH = 240;
const TASK_COLUMN_GAP = 12;

/** 依据看板容器可用宽度计算能同时展示的状态列数：最少 3 列（待处理/进行中/待审核），
 *  能放下第 4 列（已完成）时返回 4，否则保持 3 列。 */
export function computeTaskBoardColumns(containerWidth: number): number {
  const width = Math.max(0, containerWidth);
  return Math.min(4, Math.max(3, Math.floor((width + TASK_COLUMN_GAP) / (TASK_COLUMN_MIN_WIDTH + TASK_COLUMN_GAP))));
}

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
  const { language, t } = useAppPreferences();
  const actions = useProjectTaskActions(project.id);
  const runnerActions = useProjectTaskRunnerActions();
  const [editing, setEditing] = useState<ProjectTask | "new" | null>(null);
  const [viewing, setViewing] = useState<ProjectTask | null>(null);
  const [rejecting, setRejecting] = useState<ProjectTask | null>(null);
  const [deleting, setDeleting] = useState<ProjectTask | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [converting, setConverting] = useState<ProjectTask | null>(null);
  const [convertDescription, setConvertDescription] = useState("");
  const [draft, setDraft] = useState({ title: "", description: "", taskType: "code" as ProjectTaskType, agentProfile: "Claude Code", priority: "p2" as ProjectTaskPriority, baseTaskId: null as string | null });
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [doneDrawerOpen, setDoneDrawerOpen] = useState(false);
  // 自动生成标题需要本地代理（Base URL）与客户端 Token。
  const proxyBindConfig = useProxyBindConfig();
  // 看板卡片左下角的时间标签（等待 / 执行时长）需要持续前进的时钟：
  // 每秒推进一次，让进行中任务的执行时间与排队任务的等待时间实时变化。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // 看板容器宽度 → 动态列数：默认 1200×720 非独立窗口（含左侧菜单）恰好放下 3 列，
  // 容器宽度足以放下第 4 列（已完成）时展示内联已完成列，否则收进右侧抽屉。
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  // 加载失败时看板容器不挂载，恢复成功后需要重新建立观察。
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setBoardWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tasks.isError]);
  const columnCount = computeTaskBoardColumns(boardWidth);
  const showDoneColumn = columnCount >= 4;
  const visibleColumns = useMemo(
    () => (showDoneColumn ? TASK_COLUMNS : TASK_COLUMNS.filter((column) => column.id !== "done")),
    [showDoneColumn],
  );
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, tasks.data?.filter((task) => column.statuses.includes(task.status)) ?? []])) as Record<string, ProjectTask[]>, [tasks.data]);
  // 已完成任务（「已完成」列/抽屉）与任务 id → 标题 映射（展示「基于任务 X」关系、创建子任务提示）。
  const doneTasks = useMemo(() => (tasks.data ?? []).filter((task) => task.status === "done"), [tasks.data]);
  const taskTitleById = useMemo(() => new Map((tasks.data ?? []).map((task) => [task.id, task.title])), [tasks.data]);
  const openEditor = (task: ProjectTask | "new", presetBaseTaskId: string | null = null) => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", taskType: "code", agentProfile: "Claude Code", priority: "p2", baseTaskId: presetBaseTaskId } : { title: task.title, description: task.description, taskType: task.taskType, agentProfile: task.agentProfile, priority: task.priority, baseTaskId: task.baseTaskId }); };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    const task = editing === "new" ? { ...newProjectTask(project.id, draft.title, draft.baseTaskId), description: draft.description.trim(), taskType: draft.taskType, agentProfile: draft.agentProfile, priority: draft.priority } : { ...editing, ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() };
    try { await actions.saveTask.mutateAsync(task); Toast.success(t("任务已保存")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 自动生成标题：调用本地代理的 flowlet-flash 生成 -> 写入标题输入框。
  const autoGenerateTitle = async () => {
    if (!canAutoGenerateTaskTitle(draft.description)) return;
    const port = proxyBindConfig.data?.port ?? 18640;
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientToken = proxyBindConfig.data?.default_client_token;
    setGeneratingTitle(true);
    try {
      const status = await proxyCommands.status();
      if (!status.running) {
        Toast.warning(t("本地代理未运行，无法自动生成标题"));
        return;
      }
      const title = await generateTaskTitle({ baseUrl, clientToken, description: draft.description, taskType: draft.taskType });
      setDraft((current) => ({ ...current, title }));
      Toast.success(t("标题已生成"));
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setGeneratingTitle(false);
    }
  };
  // 提交 / 撤回仅在草稿与已提交之间流转（in_progress 由执行器管理，review 由审核管理）。
  // 提交后立即尝试执行一次：领取成功直接进入执行中并刷新看板；领取失败（执行槽忙）
  // 则任务保持排队等待，调度器在后悔窗口内不会自动领取，用户仍可撤回。
  const toggleSubmitted = async (task: ProjectTask, submitted: boolean) => {
    try {
      await actions.saveTask.mutateAsync({ ...task, status: submitted ? "submitted" : "draft", updatedAt: new Date().toISOString() });
      if (submitted) {
        const result = await runnerActions.startTask.mutateAsync({ projectId: project.id, taskId: task.id });
        if (result.started) {
          Toast.success(t("任务已开始执行"));
        } else {
          Toast.info(result.message || t("已有任务在执行，任务已排队等待"));
        }
      } else {
        Toast.info(t("任务已撤回"));
      }
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 删除确认弹窗确认后执行删除：成功后关闭编辑抽屉，无论成败都关闭确认弹窗。
  const removeEditingTask = async () => {
    if (!deleting) return;
    try {
      await actions.deleteTask.mutateAsync(deleting.id);
      Toast.success(t("任务已删除"));
      setEditing(null);
    } catch (error) { Toast.error(errorMessage(error)); }
    finally { setDeleting(null); }
  };
  // 审核推进：批准 → done（直接）；退回 → 弹原因 Modal → submitted 重新排队。
  const approveTask = async (task: ProjectTask) => {
    try {
      await runnerActions.setTaskStatus.mutateAsync({ taskId: task.id, status: "done" });
      setViewing(null);
      Toast.success(t("任务已通过审核"));
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 从已完成任务的只读详情直接创建子任务：关闭详情、打开新建编辑器并预置 baseTaskId。
  const createChildTask = (task: ProjectTask) => { setViewing(null); openEditor("new", task.id); };
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
  // 只读分析任务转为代码修改任务：与退回一样必填描述（新的代码修改要求）。
  const openConvert = (task: ProjectTask) => { setConverting(task); setConvertDescription(""); };
  const convertToCode = async () => {
    if (!converting) return;
    try {
      await runnerActions.convertTaskToCode.mutateAsync({ taskId: converting.id, description: convertDescription.trim() });
      setConverting(null);
      setViewing(null);
      Toast.success(t("任务已转为代码修改并重新排队"));
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  const cancelRunning = async (jobId: string) => {
    try { await backgroundTaskCommands.cancel(jobId); Toast.info(t("已请求取消执行")); } catch (error) { Toast.error(errorMessage(error)); }
  };
  /** 卡片右上角 ⋯ 菜单：按状态聚合操作，空则不渲染菜单按钮。 */
  const renderCardMenu = (task: ProjectTask): ReactNode => {
    switch (task.status) {
      case "draft":
        return <Dropdown.Item icon={<IconTickCircle />} onClick={() => void toggleSubmitted(task, true)}>{t("提交")}</Dropdown.Item>;
      case "submitted":
        return <Dropdown.Item onClick={() => void toggleSubmitted(task, false)}>{t("撤回")}</Dropdown.Item>;
      case "in_progress": {
        if (runnerState?.current?.taskId !== task.id) return null;
        return <Dropdown.Item icon={<IconStop />} onClick={() => void cancelRunning(runnerState.current!.jobId)}>{t("取消执行")}</Dropdown.Item>;
      }
      case "review":
        return (
          <>
            {task.taskType === "readonly" ? <Dropdown.Item onClick={() => openConvert(task)}>{t("转为代码修改")}</Dropdown.Item> : null}
            <Dropdown.Item icon={<IconStop />} onClick={() => openReject(task)}>{t("退回")}</Dropdown.Item>
            <Dropdown.Item icon={<IconTickCircle />} onClick={() => void approveTask(task)}>{t("批准")}</Dropdown.Item>
          </>
        );
      default:
        return null;
    }
  };

  /** 卡片左下角时间标签：草稿显示创建时间，已提交显示等待时间，其余显示累计执行时间。 */
  const renderCardMeta = (task: ProjectTask, now: number): ReactNode => {
    switch (task.status) {
      case "draft":
        return <span className={styles.taskCardTime} title={formatFullTimestamp(task.createdAt, language)}>{t("创建于 {time}", { time: formatTimestamp(task.createdAt, language) })}</span>;
      case "submitted": {
        const waiting = taskWaitingDuration(task, now);
        return waiting == null ? null : <span className={styles.taskCardTime} title={formatFullTimestamp(task.updatedAt, language)}>{t("等待 {time}", { time: formatElapsed(waiting, language) })}</span>;
      }
      default: {
        // 进行中任务当前轮次尚未结束：把正在执行的 job 传给计算函数，用实时时钟计入。
        const runningJobId = runnerState?.current?.taskId === task.id ? runnerState.current.jobId : null;
        const duration = taskTotalExecutionDuration(task, runningJobId, now);
        return <span className={styles.taskCardTime} title={t("累计执行时间")}>{t("执行 {time}", { time: formatElapsed(duration, language) })}</span>;
      }
    }
  };

  return <div className={styles.boardView}>
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : <div ref={boardRef} className={`${styles.board} ${styles.taskBoard}`} style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(${TASK_COLUMN_MIN_WIDTH}px, 1fr))` }}>
      {visibleColumns.map((column) => <section className={styles.column} key={column.id}><header><span className={styles.colTitle}><span>{t(column.label)}</span><span className={styles.colCount}>{grouped[column.id].length}</span></span>{column.addable ? <button className={styles.addColButton} aria-label={t("添加任务")} title={t("添加任务")} onClick={() => openEditor("new")}><IconPlus /></button> : null}</header><div className={styles.columnBody}>
        {grouped[column.id].map((task) => <TaskCard key={task.id} task={task} taskTitleById={taskTitleById} onOpen={(clicked) => (clicked.status === "draft" ? openEditor(clicked) : setViewing(clicked))} menu={renderCardMenu(task)} meta={renderCardMeta(task, now)} />)}
        {column.addable ? <button className={styles.addCard} onClick={() => openEditor("new")}><IconPlus />{t("添加任务")}</button> : null}
      </div></section>)}
    </div>}
    {!tasks.isError && !showDoneColumn ? <button className={styles.doneDrawerEntry} onClick={() => setDoneDrawerOpen(true)} title={t("查看已完成任务")}><IconChevronRight size="small" /><span>{t("已完成")}</span></button> : null}
    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建任务") : t("编辑任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span>{editing !== "new" && editing ? <Button type="danger" theme="borderless" icon={<IconDelete />} onClick={() => setDeleting(editing)}>{t("删除")}</Button> : null}</span><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button type="primary" theme="solid" loading={actions.saveTask.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}><div className={styles.formRow}><label><span>{t("优先级")}</span><Select value={draft.priority} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} renderSelectedItem={(optionNode: { value?: string | number }) => String(optionNode.value ?? "").toUpperCase()} optionList={PRIORITIES.map((item) => ({ value: item.value, label: `${t(item.label)} · ${t(item.description)}` }))} onChange={(value) => setDraft((current) => ({ ...current, priority: String(value) as ProjectTaskPriority }))} /></label><label><span>{t("任务标题")}</span><div className={styles.titleInputRow}><Input autoFocus value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /><Button icon={<IconAIEditLevel1 />} aria-label={t("自动生成标题")} title={canAutoGenerateTaskTitle(draft.description) ? t("根据任务描述自动生成标题") : t("任务描述至少 {n} 字后可自动生成", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })} loading={generatingTitle} disabled={!canAutoGenerateTaskTitle(draft.description)} onClick={() => void autoGenerateTitle()} /></div>{!canAutoGenerateTaskTitle(draft.description) ? <small className={styles.titleGenerateHint}>{t("任务描述至少 {n} 字后可自动生成标题", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })}</small> : null}</label></div><label><span>{t("任务描述（可选）")}</span><TextArea value={draft.description} autosize={{ minRows: 3, maxRows: 6 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><div className={styles.formGrid}><label><span>{t("任务类型")}</span><Select value={draft.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, taskType: String(value) as ProjectTaskType }))} /></label><label><span>{t("Agent Profile")}</span><Select value={draft.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} onChange={(value) => setDraft((current) => ({ ...current, agentProfile: String(value) }))} /></label></div>{draft.baseTaskId ? <div className={styles.formNote}>{t("基于已完成任务：{title}", { title: taskTitleById.get(draft.baseTaskId) ?? t("已完成任务") })}</div> : null}</div>
    </SideSheet>
    <Modal title={t("删除任务“{name}”？", { name: deleting?.title ?? "" })} visible={deleting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okType="danger" okText={t("删除")} cancelText={t("取消")} maskClosable={false} onCancel={() => setDeleting(null)} onOk={() => void removeEditingTask()} okButtonProps={{ loading: actions.deleteTask.isPending }}>
      <div className={styles.form}><p>{t("删除后任务将从项目看板移除，此操作不可撤销。")}</p></div>
    </Modal>
    <TaskReadonlySideSheet task={viewing} runningJobId={viewing?.id ? (runnerState?.current?.taskId === viewing.id ? runnerState.current.jobId : null) : null} baseTaskTitle={viewing?.baseTaskId ? taskTitleById.get(viewing.baseTaskId) ?? null : null} onClose={() => setViewing(null)} onApprove={(task) => void approveTask(task)} onReject={(task) => openReject(task)} onConvert={(task) => openConvert(task)} onCreateChildTask={(task) => createChildTask(task)} />
    <SideSheet
      visible={doneDrawerOpen}
      width={DETAIL_SHEET_WIDTH}
      motion={false}
      title={t("已完成")}
      onCancel={() => setDoneDrawerOpen(false)}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    >
      <div className={styles.doneDrawerBody}>
        {doneTasks.length === 0 ? <div className={styles.readonlyEmpty}>{t("暂无已完成任务")}</div> : (
          <div className={styles.doneDrawerList}>
            {doneTasks.map((task) => <TaskCard key={task.id} task={task} taskTitleById={taskTitleById} onOpen={(clicked) => { setDoneDrawerOpen(false); setViewing(clicked); }} menu={null} meta={renderCardMeta(task, now)} />)}
          </div>
        )}
      </div>
    </SideSheet>
    <Modal title={t("退回任务")} visible={rejecting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("退回")} cancelText={t("取消")} okType="danger" onCancel={() => setRejecting(null)} onOk={() => void rejectTask()} okButtonProps={{ loading: runnerActions.setTaskStatus.isPending, disabled: !rejectReason.trim() }}>
      <div className={styles.form}><label><span>{t("退回原因（必填）")}</span><TextArea value={rejectReason} autosize={{ minRows: 3, maxRows: 6 }} placeholder={t("说明哪里不符合预期，Agent 将据此修正后重新执行")} onChange={(value) => setRejectReason(value)} /></label></div>
    </Modal>
    <Modal title={t("转为代码修改任务")} visible={converting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("转为代码修改")} cancelText={t("取消")} onCancel={() => setConverting(null)} onOk={() => void convertToCode()} okButtonProps={{ loading: runnerActions.convertTaskToCode.isPending, disabled: !convertDescription.trim() }}>
      <div className={styles.form}><p>{t("将把该只读分析任务转为代码修改任务，并按以下说明重新排队执行。")}</p><label><span>{t("代码修改要求（必填）")}</span><TextArea value={convertDescription} autosize={{ minRows: 3, maxRows: 6 }} placeholder={t("说明需要修改哪些代码，Agent 将按此重新执行")} onChange={(value) => setConvertDescription(value)} /></label></div>
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

/** 看板任务卡片：标签 + 标题 + 左下角时间 + 右上角 ⋯ 操作。看板列与已完成抽屉共用。
 *  状态不再重复展示（由所在列表达）；优先级是唯一的彩色标签，类型与 Agent 用弱化灰色；
 *  待审核卡片悬停高亮提示，点击直接进入审核。 */
function TaskCard({ task, taskTitleById, onOpen, menu, meta }: { task: ProjectTask; taskTitleById: Map<string, string>; onOpen: (task: ProjectTask) => void; menu: ReactNode; meta: ReactNode }) {
  const { t } = useAppPreferences();
  const isReview = task.status === "review";
  return (
    <article className={`${styles.taskCard} ${isReview ? styles.taskCardReview : ""}`}>
      <div className={styles.taskCardHead}>
        <div className={styles.taskTags}>
          <span className={`${styles.taskTag} ${styles.taskTagPriority}`}>{t(priorityLabel(task.priority))}</span>
          <span className={`${styles.taskTag} ${styles.taskTagType}`}>{t(taskTypeLabel(task.taskType))}</span>
          <span className={`${styles.taskTag} ${styles.taskTagAgent}`}>{task.agentProfile}</span>
          {task.baseTaskId ? <span className={`${styles.taskTag} ${styles.taskTagBase}`} title={taskTitleById.get(task.baseTaskId) ?? t("已完成任务")}>{t("基于")}：{taskTitleById.get(task.baseTaskId) ?? t("已完成任务")}</span> : null}
        </div>
        {menu ? (
          <Dropdown
            position="bottomRight"
            trigger="click"
            clickToHide
            render={<Dropdown.Menu>{menu}</Dropdown.Menu>}
          >
            <button className={styles.taskCardMenu} aria-label={t("更多操作")} title={t("更多操作")} onClick={(event) => event.stopPropagation()}>
              <IconMore size="small" />
            </button>
          </Dropdown>
        ) : null}
      </div>
      <div className={styles.taskTitle}>
        <button className={styles.taskTitleLink} title={isReview ? t("审核任务") : task.status === "draft" ? t("编辑任务") : t("查看任务详情")} onClick={() => onOpen(task)}>
          <strong>{task.title}</strong>
        </button>
      </div>
      {meta ? <div className={styles.taskCardMeta}>{meta}</div> : null}
    </article>
  );
}

/** 提交后任务的只读详情抽屉：概览（任务信息 + 运行/调度记录）+ 会话（完整对话）。 */
function TaskReadonlySideSheet({ task, runningJobId, baseTaskTitle, onClose, onApprove, onReject, onConvert, onCreateChildTask }: { task: ProjectTask | null; runningJobId: string | null; baseTaskTitle: string | null; onClose: () => void; onApprove: (task: ProjectTask) => void; onReject: (task: ProjectTask) => void; onConvert: (task: ProjectTask) => void; onCreateChildTask: (task: ProjectTask) => void }) {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"overview" | "session">("overview");
  const [refreshing, setRefreshing] = useState(false);
  // 概览累计执行耗时需要实时时钟：进行中任务的当前轮次执行时间持续增长。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // 执行历史按时间正序（history[0] 最早）。
  // 历史缺失（早期任务未记录 execution_history）但存在最近一次 job 时，回退为该次执行。
  const history = useMemo(() => (task ? taskExecutionHistory(task) : []), [task]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  // 与「会话」Tab 的 TaskSessionView 共享同一 query，用于刷新时解析 sessionId 精确失效时间线。
  const jobDetail = useBackgroundTaskDetail(latestJobId);
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  const agentType = task ? projectAgentType(task.agentProfile) : null;
  // 刷新按钮只在任务进行中时出现：此时执行记录与对话仍在增长，需要手动拉取最新状态。
  const isRunning = task?.status === "in_progress";
  // 切换任务时回到概览。
  useEffect(() => { setActiveTab("overview"); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isReview = task?.status === "review";
  const isDone = task?.status === "done";

  /** 与「会话详情抽屉」一致：按当前 Tab 刷新对应数据。概览刷新各次执行的 job 详情，会话刷新最近一次执行及其 Agent 时间线。 */
  const refreshActiveTab = async () => {
    setRefreshing(true);
    try {
      if (activeTab === "overview") {
        await Promise.all(history.map((record) => queryClient.invalidateQueries({ queryKey: queryKeys.backgroundTask.detail(record.jobId) })));
        return;
      }
      const refetches: Promise<void>[] = [];
      if (latestJobId) refetches.push(queryClient.invalidateQueries({ queryKey: queryKeys.backgroundTask.detail(latestJobId) }));
      // sessionId 缺失时（运行中尚未落库）只刷新 job 详情，TaskSessionView 会在拿到 sessionId 后自动加载时间线。
      if (agentType && sessionId) refetches.push(queryClient.invalidateQueries({ queryKey: queryKeys.agentSession.timeline(agentType, sessionId) }));
      await Promise.all(refetches);
    } finally {
      setRefreshing(false);
    }
  };
  const footer = (
    <div className={styles.taskSheetFooter}><span></span><span className={styles.taskSheetFooterActions}>
      {isDone && task ? <Button type="primary" theme="solid" onClick={() => onCreateChildTask(task)}>{t("基于此任务创建子任务")}</Button> : null}
      {isReview && task ? (
        <>
          {task.taskType === "readonly" ? <Button onClick={() => onConvert(task)}>{t("转为代码修改")}</Button> : null}
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
      bodyStyle={{ padding: 0 }}
    >
      {task ? (
        <Tabs
          type="line"
          activeKey={activeTab}
          tabPaneMotion={false}
          onChange={(key) => setActiveTab(key as "overview" | "session")}
          className={styles.taskReadonlyTabs}
          tabBarExtraContent={isRunning ? (
            <Button
              className={styles.taskTabRefresh}
              icon={<IconRefresh />}
              aria-label={t("刷新")}
              size="small"
              theme="borderless"
              loading={refreshing}
              onClick={() => void refreshActiveTab()}
            >
              {t("刷新")}
            </Button>
          ) : undefined}
        >
          <Tabs.TabPane tab={t("概览")} itemKey="overview">
            <div className={styles.readonlyTabsBody}>
              <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("任务信息")}</strong>
                <div className={styles.readonlyGrid}>
                  <ReadonlyItem label={t("任务 ID")} value={task.id} copyable copyLabel={t("任务 ID")} />
                  <ReadonlyItem label={t("Agent 会话 ID")} value={sessionId ?? t("未执行")} copyable={Boolean(sessionId)} copyLabel={t("Agent 会话 ID")} />
                  <ReadonlyItem label={t("创建时间")} value={formatTimestamp(task.createdAt, language)} />
                  <ReadonlyItem label={t("更新时间")} value={formatTimestamp(task.updatedAt, language)} />
                  <ReadonlyItem label={t("总等待耗时")} value={formatElapsed(taskTotalWaitingDuration(task), language)} />
                  <ReadonlyItem label={t("总执行耗时")} value={formatElapsed(taskTotalExecutionDuration(task, runningJobId, now), language)} />
                  {baseTaskTitle ? <ReadonlyItem label={t("基于任务")} value={baseTaskTitle} wide /> : null}
                  <ReadonlyItem label={t("任务描述")} value={task.description.trim() || t("无描述")} wide />
                </div>
              </section>
              <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("Agent 执行情况")}</strong>
                {history.length === 0 ? <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无 Agent 执行记录")}</div> : (
                  <div className={styles.runRecordList}>
                    {history.map((record, index) => <TaskExecutionRun key={record.jobId} record={record} index={index} />)}
                  </div>
                )}
              </section>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("会话")} itemKey="session">
            <div className={styles.readonlyTabsBody}>
              <TaskSessionView task={task} />
            </div>
          </Tabs.TabPane>
        </Tabs>
      ) : null}
    </SideSheet>
  );
}

/** 单次执行的运行/调度记录：job 状态、起止时间与运行事件（不含 Agent 输出正文）。 */
function TaskExecutionRun({ record, index }: { record: TaskExecutionRecord; index: number }) {
  const { language, t } = useAppPreferences();
  const detail = useBackgroundTaskDetail(record.jobId);
  const job = detail.data?.job;
  // 「输出」事件是 Agent 流式正文（体量巨大），会话内容放「会话」Tab，概览只保留运行/调度记录。
  const runEvents = (detail.data?.events ?? []).filter((event) => event.stage !== "输出");
  const state = detail.isLoading
    ? t("正在读取执行记录…")
    : detail.isError
      ? t("执行记录读取失败：{message}", { message: detail.error.message })
      : !job
        ? t("执行记录已清理或不可用")
        : null;
  return (
    <article className={styles.runRecord}>
      <header className={styles.runRecordHead}>
        <strong>{t("第 {n} 次执行", { n: index + 1 })}</strong>
        <span className={styles.runRecordBadges}>
          {record.rejected ? <Tag size="small" color="red">{t("已退回")}</Tag> : null}
          {job ? <JobStatusTag status={job.status} t={t} /> : null}
        </span>
      </header>
      {state ? <div className={styles.readonlyEmpty}>{state}</div> : null}
      {record.rejected && record.rejectionReason ? (
        <div className={styles.readonlyRejected}>
          <strong>{t("退回原因：{reason}", { reason: record.rejectionReason })}</strong>
          {record.rejectedAt ? <time>{formatTimestamp(record.rejectedAt, language)}</time> : null}
        </div>
      ) : null}
      {job ? (
        <>
          <div className={styles.runRecordMeta}>
            <span>{t("开始 {time}", { time: formatTimestamp(job.startedAt ?? job.createdAt, language) })}</span>
            {job.finishedAt ? <span>{t("结束 {time}", { time: formatTimestamp(job.finishedAt, language) })}</span> : null}
            {job.stage ? <span className={styles.runRecordStage}>{job.stage}</span> : null}
          </div>
          {job.errorMessage ? <div className={styles.readonlyJobError}>{job.errorMessage}</div> : null}
        </>
      ) : null}
      {runEvents.length > 0 ? (
        <ul className={styles.runRecordEvents}>
          {runEvents.map((event) => (
            <li key={event.id}>
              <span className={styles.runRecordEventStage}>{event.stage ?? t("处理")}</span>
              <time>{formatTimestamp(event.createdAt, language)}</time>
              <p>{event.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** 任务「会话」Tab：读取最近一次执行产生的 Agent 会话，展示完整对话（全部交互）。 */
function TaskSessionView({ task }: { task: ProjectTask }) {
  const { language, t } = useAppPreferences();
  const history = useMemo(() => taskExecutionHistory(task), [task]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  const jobDetail = useBackgroundTaskDetail(latestJobId);
  // 运行中的任务 summary_json 尚无 sessionId（完成后才写入），回退从 job 的「会话」事件解析。
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  const agentType = projectAgentType(task.agentProfile);
  const timeline = useAgentSessionTimeline(agentType, sessionId, Boolean(sessionId));
  if (!latestJobId) {
    return <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无会话记录")}</div>;
  }
  if (jobDetail.isLoading) {
    return <div className={styles.readonlyEmpty}>{t("正在读取执行记录…")}</div>;
  }
  if (jobDetail.isError) {
    return <div className={styles.readonlyEmpty}>{t("执行记录读取失败：{message}", { message: jobDetail.error.message })}</div>;
  }
  if (!sessionId) {
    return <div className={styles.readonlyEmpty}>{t("该任务执行未产生可展示的 Agent 会话")}</div>;
  }
  return (
    <SessionConversation
      events={timeline.data?.events ?? []}
      truncated={timeline.data?.truncated ?? false}
      loading={timeline.isLoading}
      error={timeline.isError ? timeline.error.message : null}
      language={language}
      onRetry={() => void timeline.refetch()}
    />
  );
}

/** 从 background_jobs.summary_json 中解析项目任务执行产生的 sessionId。 */
function parseJobSessionId(summaryJson: string | null): string | null {
  if (!summaryJson) return null;
  try {
    const parsed = JSON.parse(summaryJson) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

/** 从 job 事件流中「会话」stage 的消息（如 "Claude Code 会话已初始化：<id>"）提取 sessionId。 */
function parseSessionIdFromEvents(events: BackgroundJobEvent[]): string | null {
  for (const event of events) {
    if (event.stage !== "会话") continue;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(event.message);
    if (match) return match[1];
  }
  return null;
}

/** 任务 Agent Profile → 会话读取用的 agent_type。 */
function projectAgentType(agentProfile: string): "claude-code" | "opencode" | "pi" | null {
  if (agentProfile === "Claude Code") return "claude-code";
  if (agentProfile === "OpenCode") return "opencode";
  if (agentProfile === "Pi") return "pi";
  return null;
}

function TaskReadonlyHeader({ task }: { task: ProjectTask }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.readonlyHeader}>
      <strong className={styles.readonlyHeaderTitle} title={task.title}>{task.title}</strong>
      <div className={styles.taskTags}>
        <span className={`${styles.taskTag} ${styles.taskTagPriority}`}>{t(priorityLabel(task.priority))}</span>
        <span className={statusTagClass(task.status)}>{t(statusTagLabel(task.status))}</span>
        <span className={`${styles.taskTag} ${styles.taskTagType}`}>{t(taskTypeLabel(task.taskType))}</span>
        <span className={`${styles.taskTag} ${styles.taskTagAgent}`}>{task.agentProfile}</span>
      </div>
    </div>
  );
}

function ReadonlyItem({ label, value, wide = false, copyable = false, copyLabel }: { label: string; value: string; wide?: boolean; copyable?: boolean; copyLabel?: string }) {
  const { t } = useAppPreferences();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{label} 已复制", { label: copyLabel ?? label }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  return <div className={`${styles.readonlyItem} ${wide ? styles.readonlyItemWide : ""}`}><span>{label}</span><div className={styles.readonlyItemValue}><strong title={value}>{value}</strong>{copyable ? <button className={styles.readonlyItemCopy} aria-label={t("复制{label}", { label })} title={t("复制{label}", { label })} onClick={() => void copy()}><IconCopy size="extra-small" /></button> : null}</div></div>;
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

