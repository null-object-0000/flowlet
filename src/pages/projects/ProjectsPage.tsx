import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Empty, Input, Modal, Select, SideSheet, Tabs, Tag, TextArea, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconAIEditLevel1, IconChevronRight, IconCopy, IconDelete, IconEdit, IconFolder, IconMore, IconPlus, IconRefresh, IconSearch, IconStop, IconTickCircle, IconTop, IconUndo } from "@douyinfe/semi-icons";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ProjectsBoardTaskCardView, ProjectsBoardView } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { BackgroundJobEvent } from "../../domains/background-task/types";
import { agentSessionCommands } from "../../domains/agent-session/commands";
import type { AgentSessionFlowletUsage, AgentSessionNativeUsage } from "../../domains/agent-session/types";
import { deviceSyncCommands } from "../../domains/device-sync/commands";
import { MIN_TITLE_GENERATION_DESCRIPTION_LENGTH, canAutoGenerateTaskTitle, generateTaskTitle } from "../../domains/project/generateTaskTitle";
import type { Project, ProjectTask, ProjectTaskMutableStatus, ProjectTaskQueueBlocker, ProjectTaskRunnerState, ProjectTaskStatus, ProjectTaskType, TaskExecutionRecord } from "../../domains/project/types";
import { proxyCommands } from "../../domains/proxy/commands";
import { taskExecutionHistory, taskExecutionRound, taskHasExecution, taskIsRevisionDraft, taskLatestExecutionDuration, taskRecordExecutionDuration, taskRecordWaitingDuration, taskTotalExecutionDuration, taskTotalWaitingDuration, taskWaitingDuration } from "../../domains/project/types";
import { SessionConversation } from "../../features/agent-sessions/SessionConversation";
import { interactionEventsVersion, useSessionScrollFollow } from "../../features/agent-sessions/useSessionScrollFollow";
import { useAgentSessionTimeline } from "../../features/agent-sessions/useAgentSessions";
import { useBackgroundTaskDetail } from "../../features/background-tasks/useBackgroundTasks";
import { newProject, newProjectTask, useProject, useProjectActions, useProjects, useProjectTaskActions, useProjectTaskRunnerActions, useProjectTaskScheduler, useProjectTasks } from "../../features/projects/useProjects";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { errorMessage } from "../../shared/errors/AppError";
import { formatCostAmount } from "../../shared/formatters/cost";
import { formatFullTimestamp, formatTimestamp } from "../../shared/formatters/datetime";
import { queryKeys } from "../../shared/query-keys";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { ScrollBottomControl } from "../../shared/ui/ScrollBottomControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { formatElapsed, formatElapsedSeconds } from "../task-logs/taskDuration";
import { mergeProjectTasks, type RemoteTaskOrigin } from "./mergeProjectTasks";
import styles from "./ProjectsPage.module.css";

// 任务概览抽屉「会话」Tab 在任务执行中自动刷新对话的间隔，与移动端会话详情抽屉一致。
const SESSION_AUTO_REFRESH_MS = 5_000;

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
    <section className={styles.projectList}>
      {projects.data?.map((project) => <article key={project.id} className={styles.projectCard} onClick={() => navigate(`/projects/${project.id}`)}>
        <div className={styles.projectIcon}><IconFolder /></div>
        <div className={styles.projectCopy}><strong>{project.name}</strong><span title={project.directoryPath ?? undefined}>{project.directoryPath ?? t("未绑定目录")}</span></div>
        <small className={styles.projectUpdated}>{t("更新于 {time}", { time: formatTimestamp(project.updatedAt, language) })}</small>
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
  const refresh = useRefreshControl({ intervalMs: 1_000 });
  const tasks = useProjectTasks(project.id, refresh.autoRefresh, refresh.intervalMs);
  const sharedProjects = useQuery({
    queryKey: queryKeys.deviceSync.projects(null),
    queryFn: () => deviceSyncCommands.projects(null),
    refetchInterval: refresh.autoRefresh ? refresh.intervalMs : false,
    refetchOnWindowFocus: false,
  });
  // 看板任务搜索词：标题 / ID / 描述等关键词过滤，只影响当前看板展示。
  const [search, setSearch] = useState("");
  // 前端调度器：进入项目详情页即自动轮询「槽空闲 && 有待处理任务」，有空闲就领取执行。
  // 领取失败（Agent 未安装 / 进程启动失败等）时提示原因，避免任务静默卡在待处理。
  const scheduler = useProjectTaskScheduler(
    refresh.autoRefresh,
    refresh.intervalMs,
    (message, taskId) => {
      const task = tasks.data?.find((item) => item.id === taskId);
      Toast.error(t("任务「{title}」领取执行失败：{message}", {
        title: task?.title ?? shortTaskId(taskId),
        message,
      }));
    },
  );
  // 「在独立窗口打开」能力已移至右上角窗口控制区（AppShell → WindowControls 注入）。
  return <main className={styles.page}>
    <PageHeader title={project.name} subtitle={project.directoryPath ?? t("未绑定目录")}>
      <Input
        className={styles.taskSearch}
        prefix={<IconSearch />}
        value={search}
        placeholder={t("搜索任务标题、ID 或描述")}
        showClear
        onChange={setSearch}
      />
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={tasks.isFetching || sharedProjects.isFetching || scheduler.runnerState.isFetching || scheduler.queued.isFetching}
        lastUpdatedAt={Math.max(tasks.dataUpdatedAt, sharedProjects.dataUpdatedAt, scheduler.runnerState.dataUpdatedAt, scheduler.queued.dataUpdatedAt)}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void Promise.all([tasks.refetch(), sharedProjects.refetch(), scheduler.runnerState.refetch(), scheduler.queued.refetch()])}
        language={language}
        t={t}
      />
    </PageHeader>
    <section className={styles.detailContent}>
      <TaskBoard project={project} tasks={tasks} sharedProjects={sharedProjects.data ?? []} sharedProjectsError={sharedProjects.isError ? sharedProjects.error.message : null} runnerState={scheduler.runnerState.data} queued={scheduler.queued.data?.tasks ?? []} queueBlockers={scheduler.queued.data?.blockers ?? []} search={search} />
    </section>
  </main>;
}

/** 看板卡片交互动作：单个动作在卡片右下角直接渲染按钮，多个动作收进右上角 ⋯ 菜单（悬停露出）。 */
export type CardAction = {
  key: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
};

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

/** 看板任务搜索：关键词过滤任务，匹配标题、任务 ID、描述、类型（值/中文标签）与
 *  Agent，不区分大小写。空关键词返回原列表。 */
export function filterProjectTasks(tasks: ProjectTask[], keyword: string): ProjectTask[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return tasks;
  return tasks.filter((task) => (
    task.title.toLowerCase().includes(kw)
    || task.id.toLowerCase().includes(kw)
    || task.description.toLowerCase().includes(kw)
    || task.agentProfile.toLowerCase().includes(kw)
    || task.taskType.toLowerCase().includes(kw)
    || taskTypeLabel(task.taskType).toLowerCase().includes(kw)
  ));
}

/** 已完成任务树构建：baseTaskId 指向已完成任务的子任务归到父任务下，其余作为根任务。
 *  供看板已完成列/抽屉分组展示——父任务卡片承载子任务列表，可展开/收缩（默认展开）。 */
export function buildDoneTaskTree(doneTasks: ProjectTask[]): { childrenMap: Map<string, ProjectTask[]>; roots: ProjectTask[] } {
  const childrenMap = new Map<string, ProjectTask[]>();
  const roots: ProjectTask[] = [];
  const doneIdSet = new Set(doneTasks.map((task) => task.id));
  for (const task of doneTasks) {
    if (task.baseTaskId && doneIdSet.has(task.baseTaskId)) {
      const list = childrenMap.get(task.baseTaskId);
      if (list) list.push(task); else childrenMap.set(task.baseTaskId, [task]);
    } else {
      roots.push(task);
    }
  }
  return { childrenMap, roots };
}

const TASK_TYPES: Array<{ value: ProjectTaskType; label: string }> = [
  { value: "code", label: "代码修改" },
  { value: "readonly", label: "只读分析" },
];

const AGENT_PROFILES = ["Claude Code", "OpenCode", "Pi", "Codex"];

function TaskBoard({ project, tasks, sharedProjects, sharedProjectsError, runnerState, queued, queueBlockers, search }: { project: Project; tasks: ReturnType<typeof useProjectTasks>; sharedProjects: Awaited<ReturnType<typeof deviceSyncCommands.projects>>; sharedProjectsError: string | null; runnerState?: ProjectTaskRunnerState; queued: ProjectTask[]; queueBlockers: ProjectTaskQueueBlocker[]; search: string }) {
  const { language, t } = useAppPreferences();
  const actions = useProjectTaskActions(project.id);
  const runnerActions = useProjectTaskRunnerActions();
  // 当前设备 id（known_devices 中 isCurrent）：用于判断任务是否归属其他设备（只读）。
  const knownDevices = useQuery({
    queryKey: queryKeys.deviceSync.devices(),
    queryFn: () => deviceSyncCommands.devices(),
    refetchOnWindowFocus: false,
  });
  const currentDeviceId = knownDevices.data?.find((device) => device.isCurrent)?.deviceId ?? null;
  const queueBlockerByTaskId = useMemo(
    () => new Map(queueBlockers.map((blocker) => [blocker.taskId, blocker])),
    [queueBlockers],
  );
  const deviceNameById = useMemo(
    () => new Map((knownDevices.data ?? []).map((device) => [device.deviceId, device.displayName])),
    [knownDevices.data],
  );
  const [editing, setEditing] = useState<ProjectTask | "new" | null>(null);
  const [viewing, setViewing] = useState<ProjectTask | null>(null);
  const [historyReturnTaskId, setHistoryReturnTaskId] = useState<string | null>(null);
  // 系统通知点击跳转：独立窗口首次挂载从 URL `?task=` 读取目标任务，
  // 之后监听 `task-detail-open` 事件更新。任务加载完成后自动打开其概览抽屉。
  const [searchParams] = useSearchParams();
  const [targetTaskId, setTargetTaskId] = useState<string | null>(() => searchParams.get("task"));
  const [rejecting, setRejecting] = useState<ProjectTask | null>(null);
  const [deleting, setDeleting] = useState<ProjectTask | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [converting, setConverting] = useState<ProjectTask | null>(null);
  const [convertDescription, setConvertDescription] = useState("");
  const [draft, setDraft] = useState({ title: "", description: "", taskType: "code" as ProjectTaskType, agentProfile: "Claude Code", baseTaskId: null as string | null });
  const [generatingTitle, setGeneratingTitle] = useState(false);
  // 标题流式生成过程中的实时进度（展示在「任务标题」名称右侧，缓解等待焦虑）。
  const [titleGenStatus, setTitleGenStatus] = useState<string | null>(null);
  const [doneDrawerOpen, setDoneDrawerOpen] = useState(false);
  // 已完成列中父任务卡片收缩/展开状态：子任务收缩到父任务卡片内展示，默认展开。
  const [collapsedDoneParents, setCollapsedDoneParents] = useState<Set<string>>(() => new Set());
  // 自动生成标题需要本地代理（Base URL）与客户端 Token。
  const proxyBindConfig = useProxyBindConfig();
  // 看板卡片左下角的时间标签（等待 / 执行时长）需要持续前进的时钟：
  // 看板卡片左下角的时间标签（等待 / 执行时长）需要持续前进的时钟：
  // 与看板数据刷新保持同一节奏（每秒推进一次），让进行中任务的执行时间
  // 与排队任务的等待时间实时变化。
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
  // 展示层合并本机事实任务与其他设备轻量快照；本机 UUID 优先，远端任务保持只读。
  const mergedTasks = useMemo(
    () => mergeProjectTasks(project, tasks.data ?? [], sharedProjects),
    [project, tasks.data, sharedProjects],
  );
  const boardTasks = mergedTasks.tasks;
  const remoteOrigins = mergedTasks.remoteOrigins;
  // 搜索过滤：关键词匹配标题 / 任务 ID / 描述 / 类型 / Agent，空关键词返回全部。
  const searchKeyword = search.trim().toLowerCase();
  const filteredTasks = useMemo(() => filterProjectTasks(boardTasks, searchKeyword), [boardTasks, searchKeyword]);
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, filteredTasks.filter((task) => column.statuses.includes(task.status))])) as Record<string, ProjectTask[]>, [filteredTasks]);
  // 已完成任务（「已完成」列/抽屉）与任务 id → 任务 映射（展示「基于任务」关系、点击打开父任务、创建子任务提示）。
  const doneTasks = useMemo(() => filteredTasks.filter((task) => task.status === "done"), [filteredTasks]);
  const taskById = useMemo(() => new Map(boardTasks.map((task) => [task.id, task])), [boardTasks]);
  // 已完成任务树：baseTaskId 指向已完成任务的子任务收缩到父任务卡片中展示。
  // 父任务不在已完成列表（或不在当前搜索命中结果）中的任务作为独立根任务展示。
  const doneTree = useMemo(() => buildDoneTaskTree(doneTasks), [doneTasks]);
  // 搜索词命中不到任何任务时，看板整体显示空态；「已完成」抽屉入口在搜索下无匹配已完成任务时同样隐藏。
  const noSearchMatch = searchKeyword.length > 0 && filteredTasks.length === 0;
  const showDoneDrawerEntry = !showDoneColumn && !(searchKeyword.length > 0 && doneTasks.length === 0);
  const openEditor = (task: ProjectTask | "new", presetBaseTaskId: string | null = null) => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", taskType: "code", agentProfile: "Claude Code", baseTaskId: presetBaseTaskId } : { title: task.title, description: task.description, taskType: task.taskType, agentProfile: task.agentProfile, baseTaskId: task.baseTaskId }); };
  // 打开任意任务：本机草稿进编辑抽屉；远端快照 / 其他设备执行过的任务只读打开详情。
  const openAnyTask = (clicked: ProjectTask) => {
    if (clicked.status === "draft" && !remoteOrigins.has(clicked.id) && !taskOwnedByOtherDevice(clicked, taskById, currentDeviceId)) openEditor(clicked);
    else setViewing(clicked);
  };
  const openTaskHistory = (task: ProjectTask, returnToCurrentDraft = false) => {
    setHistoryReturnTaskId(returnToCurrentDraft ? task.id : null);
    setEditing(null);
    setViewing(task);
  };
  const editDraftFromHistory = (task: ProjectTask) => {
    setViewing(null);
    if (historyReturnTaskId === task.id) setEditing(task);
    else openEditor(task);
    setHistoryReturnTaskId(null);
  };
  // 监听「任务详情打开」事件（Rust 侧在通知点击时向本独立窗口发出）。
  // 事件只定向到 project-detail-<projectId> 窗口，主窗口不会收到。
  useEffect(() => {
    const unlistenPromise = listen<{ projectId: string; taskId: string }>("task-detail-open", (event) => {
      const { projectId, taskId } = event.payload;
      if (projectId === project.id) {
        setTargetTaskId(taskId);
      }
    });
    return () => {
      void unlistenPromise.then((dispose) => dispose());
    };
  }, [project.id]);
  // 目标任务已加载到看板时自动打开其概览抽屉（URL ?task= 与事件共用此入口）。
  useEffect(() => {
    if (!targetTaskId) return;
    const target = taskById.get(targetTaskId);
    if (!target) return;
    openAnyTask(target);
    setTargetTaskId(null);
  }, [targetTaskId, taskById, openAnyTask]);
  // 卡片「来源设备」标签：远端快照显示来源设备名；其他设备执行过的本机任务显示执行设备名。
  const taskSourceLabel = (task: ProjectTask): string | undefined => {
    const remote = remoteOrigins.get(task.id);
    if (remote) return remote.deviceDisplayName;
    if (taskOwnedByOtherDevice(task, taskById, currentDeviceId) && task.claimedBy) {
      return deviceNameById.get(task.claimedBy) ?? task.claimedBy;
    }
    return undefined;
  };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    const task = editing === "new" ? { ...newProjectTask(project.id, draft.title, draft.baseTaskId), description: draft.description.trim(), taskType: draft.taskType, agentProfile: draft.agentProfile } : { ...editing, ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() };
    try { await actions.saveTask.mutateAsync(task); Toast.success(t("任务已保存")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 自动生成标题：调用本地代理的 flowlet-flash 生成 -> 写入标题输入框。
  const autoGenerateTitle = async () => {
    if (!canAutoGenerateTaskTitle(draft.description)) return;
    const port = proxyBindConfig.data?.port ?? 18640;
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientToken = proxyBindConfig.data?.default_client_token;
    setGeneratingTitle(true);
    setTitleGenStatus(t("AI 正在生成标题…"));
    try {
      const status = await proxyCommands.status();
      if (!status.running) {
        Toast.warning(t("本地代理未运行，无法自动生成标题"));
        return;
      }
      const title = await generateTaskTitle(
        { baseUrl, clientToken, description: draft.description, taskType: draft.taskType },
        (progress) => {
          setTitleGenStatus(t("AI 生成中… 已输出 {tokens} tokens，{seconds} 秒", { tokens: progress.tokenEstimate, seconds: Math.max(1, Math.round(progress.elapsedMs / 1000)) }));
        },
      );
      setDraft((current) => ({ ...current, title }));
      Toast.success(t("标题已生成"));
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setGeneratingTitle(false);
      setTitleGenStatus(null);
    }
  };
  // 提交 / 撤回仅在草稿与已提交之间流转（in_progress 由执行器管理，review 由审核管理）。
  // 提交后立即尝试执行一次：领取成功直接进入执行中并刷新看板；领取失败（执行槽忙）
  // 则任务保持排队等待，调度器在后悔窗口内不会自动领取，用户仍可撤回。
  const toggleSubmitted = async (task: ProjectTask, submitted: boolean) => {
    try {
      if (submitted) {
        // 提交：草稿 → 已提交。走内容保存命令（草稿状态可编辑），成功后立即尝试执行一次。
        await actions.saveTask.mutateAsync({ ...task, status: "submitted", updatedAt: new Date().toISOString() });
        const result = await runnerActions.startTask.mutateAsync({ projectId: project.id, taskId: task.id });
        if (result.started) {
          Toast.success(t("任务已开始执行"));
        } else {
          // 排队等待的任务会自动被调度器执行，这里不展示 Rust 返回的
          // 「已有任务在执行中，请稍后重试」文案，明确告知已进入队列。
          Toast.info(t("已有任务在执行，任务已进入队列，完成后将自动执行"));
        }
      } else {
        // 撤回：已提交 → 草稿。这是纯状态迁移，走 set_project_task_status；
        // save_project_task 只允许编辑草稿状态任务，已提交任务会被拦截。
        await runnerActions.setTaskStatus.mutateAsync({ taskId: task.id, status: "draft" });
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
  // 退回与任务提交一致：退回（submitted）后立即尝试执行一次，能执行直接进入
  // 执行中并刷新看板；不能执行（执行槽忙）则保持排队等待，调度器在后悔窗口内
  // 不会自动领取，用户仍可撤回。退回原因已由 setTaskStatus 写入，run_project_task
  // 会读取并注入给 Agent 修正。
  const rejectTask = async () => {
    if (!rejecting) return;
    try {
      await runnerActions.setTaskStatus.mutateAsync({ taskId: rejecting.id, status: "submitted", reason: rejectReason.trim() });
      const result = await runnerActions.startTask.mutateAsync({ projectId: rejecting.projectId, taskId: rejecting.id });
      setRejecting(null);
      setViewing(null);
      if (result.started) {
        Toast.success(t("任务已退回并开始执行"));
      } else {
        // 排队等待的任务会自动被调度器执行，不展示 Rust 的「请稍后重试」文案。
        Toast.info(t("任务已退回，已进入队列，完成后将自动执行"));
      }
    } catch (error) { Toast.error(errorMessage(error)); }
  };
  // 置顶：把已提交待执行任务提到队列最前。
  const boostTaskInQueue = async (task: ProjectTask) => {
    try {
      await runnerActions.boostTask.mutateAsync(task.id);
      Toast.success(t("任务已置顶到队列最前"));
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
  /** 卡片交互动作：按状态聚合。
   *  单个动作直接在卡片右下角渲染按钮；多个动作收进右上角 ⋯ 菜单（悬停卡片时露出）。
   *  远端快照与其他设备执行/归属的任务：本机只读，不提供任何操作。 */
  const renderCardActions = (task: ProjectTask): CardAction[] => {
    if (remoteOrigins.has(task.id)) return [];
    if (taskOwnedByOtherDevice(task, taskById, currentDeviceId)) return [];
    switch (task.status) {
      case "draft":
        return taskIsRevisionDraft(task)
          ? [
              { key: "history", label: t("查看历史"), onClick: () => openTaskHistory(task) },
              { key: "submit", label: t("提交"), icon: <IconTickCircle />, onClick: () => void toggleSubmitted(task, true) },
            ]
          : [{ key: "submit", label: t("提交"), icon: <IconTickCircle />, onClick: () => void toggleSubmitted(task, true) }];
      case "submitted":
        return [
          { key: "boost", label: t("置顶"), icon: <IconTop />, onClick: () => void boostTaskInQueue(task) },
          { key: "withdraw", label: t("撤回"), icon: <IconUndo />, onClick: () => void toggleSubmitted(task, false) },
        ];
      case "in_progress":
        // 进行中任务不提供取消执行，交给执行器自然完成后流转到待审核。
        return [];
      case "review": {
        const actions: CardAction[] = [];
        if (task.taskType === "readonly") actions.push({ key: "convert", label: t("转为代码修改"), onClick: () => openConvert(task) });
        actions.push({ key: "reject", label: t("退回"), icon: <IconStop />, onClick: () => openReject(task) });
        actions.push({ key: "approve", label: t("批准"), icon: <IconTickCircle />, onClick: () => void approveTask(task) });
        return actions;
      }
      default:
        return [];
    }
  };

  /** 卡片左下角时间标签：草稿显示创建时间，已提交显示等待时间 + 排队顺序，其余显示累计执行时间。
   *  已提交且上次执行被应用重启中断的任务，在时间标签前附加「上次执行中断」警示标记。
   *  其他设备执行/归属的任务只读展示更新时间。 */
  const renderCardMeta = (task: ProjectTask, now: number): ReactNode => {
    const remoteOrigin = remoteOrigins.get(task.id);
    if (remoteOrigin) {
      return <span className={styles.taskCardTime} title={formatFullTimestamp(task.updatedAt, language)}>{t("{device} · 更新于 {time}", { device: remoteOrigin.deviceDisplayName, time: formatTimestamp(task.updatedAt, language) })}</span>;
    }
    // 其他设备执行/归属的任务：本机只读，「其他设备 · 设备名」由来源标签展示，这里展示更新时间。
    if (taskOwnedByOtherDevice(task, taskById, currentDeviceId)) {
      return <span className={styles.taskCardTime} title={formatFullTimestamp(task.updatedAt, language)}>{t("更新于 {time}", { time: formatTimestamp(task.updatedAt, language) })}</span>;
    }
    switch (task.status) {
      case "draft":
        return taskIsRevisionDraft(task)
          ? <span className={styles.taskCardTime} title={formatFullTimestamp(task.updatedAt, language)}>{t("更新于 {time}", { time: formatTimestamp(task.updatedAt, language) })}</span>
          : <span className={styles.taskCardTime} title={formatFullTimestamp(task.createdAt, language)}>{t("创建于 {time}", { time: formatTimestamp(task.createdAt, language) })}</span>;
      case "submitted": {
        const waiting = taskWaitingDuration(task, now);
        const interrupted = taskLastExecutionInterrupted(task);
        // 排队顺序：任务在全局待执行队列（list_queued_project_tasks 排序）中的第几位；
        // 不在队列中（已被领取执行）时不展示。
        const queueIndex = queued.findIndex((item) => item.id === task.id);
        const queuePosition = queueIndex >= 0 ? queueIndex + 1 : null;
        return (
          <span className={styles.taskCardMetaRight}>
            {interrupted ? (
              <span
                className={`${styles.taskTag} ${styles.taskTagInterrupted}`}
                title={t("上次执行因应用重启中断，任务已回到待处理，将自动重新执行")}
              >
                {t("上次执行中断")}
              </span>
            ) : null}
            {waiting == null ? null : <span className={styles.taskCardTime} title={formatFullTimestamp(task.updatedAt, language)}>{t("等待 {time}", { time: formatElapsedSeconds(waiting) })}</span>}
            {queuePosition != null ? <span className={styles.taskCardTime}>{t("队列第 {n} 位", { n: queuePosition })}</span> : null}
          </span>
        );
      }
      case "in_progress": {
        // 进行中取实时时钟（当前轮次未结束），具体到秒展示，随看板每秒刷新。
        const runningJobId = (runnerState?.current ?? []).find((info) => info.taskId === task.id)?.jobId ?? null;
        const duration = taskLatestExecutionDuration(task, runningJobId, now);
        return <span className={styles.taskCardTime} title={t("本轮执行时间")}>{t("执行 {time}", { time: formatElapsedSeconds(duration) })}</span>;
      }
      case "review": {
        // 待审核取最近一轮的真实执行耗时（时间已定），保持原有分钟级呈现。
        const runningJobId = (runnerState?.current ?? []).find((info) => info.taskId === task.id)?.jobId ?? null;
        const duration = taskLatestExecutionDuration(task, runningJobId, now);
        return <span className={styles.taskCardTime} title={t("本轮执行时间")}>{t("执行 {time}", { time: formatElapsed(duration, language) })}</span>;
      }
      case "done": {
        // 已完成才展示多轮（被退回后重新执行）累计的总执行耗时。
        const duration = taskTotalExecutionDuration(task, null, now);
        return <span className={styles.taskCardTime} title={t("累计执行时间")}>{t("执行 {time}", { time: formatElapsed(duration, language) })}</span>;
      }
      default:
        return null;
    }
  };

  /** 递归渲染已完成任务树：父任务卡片承载其子任务列表（收缩/展开），子任务默认展示。
   *  openOverride 用于「已完成」抽屉：先关闭抽屉再打开任务详情。 */
  const renderDoneTask = (task: ProjectTask, depth = 0, openOverride?: (task: ProjectTask) => void): ReactNode => {
    const children = doneTree.childrenMap.get(task.id) ?? [];
    const hasChildren = children.length > 0;
    const expanded = !collapsedDoneParents.has(task.id);
    const toggle = () => {
      setCollapsedDoneParents((current) => {
        const next = new Set(current);
        if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
        return next;
      });
    };
    return (
      <TaskCard
        key={task.id}
        task={task}
        taskById={taskById}
        onOpen={openOverride ?? openAnyTask}
        actions={[]}
        meta={renderCardMeta(task, now)}
        depth={depth}
        expandable={hasChildren}
        expanded={expanded}
        childCount={children.length}
        onToggleExpand={hasChildren ? toggle : undefined}
        sourceLabel={taskSourceLabel(task)}
      >
        {hasChildren && expanded ? (
          <div className={styles.taskCardChildren}>
            {children.map((child) => renderDoneTask(child, depth + 1, openOverride))}
          </div>
        ) : null}
      </TaskCard>
    );
  };

  return <div className={styles.boardView}>
    {sharedProjectsError ? <div className={styles.remoteLoadWarning}>{t("其他设备任务读取失败：{message}", { message: sharedProjectsError })}</div> : null}
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : (
      <ProjectsBoardView
        boardRef={boardRef}
        columnCount={columnCount}
        columnMinWidth={TASK_COLUMN_MIN_WIDTH}
        labels={{ emptyHint: t("暂无任务"), running: t("运行中") }}
        emptyState={noSearchMatch ? <Empty title={t("没有匹配的任务")} description={t("试试搜索标题、任务 ID 或描述关键词")} /> : undefined}
        columns={visibleColumns.map((column) => ({
          id: column.id,
          title: t(column.label),
          count: grouped[column.id].length,
          tone: column.id === "review" ? "warning" : column.id === "done" ? "success" : "primary",
          addAction: column.addable ? { label: t("添加任务"), icon: <IconPlus />, onClick: () => openEditor("new") } : undefined,
          content: column.id === "done"
            ? doneTree.roots.map((task) => renderDoneTask(task))
            : grouped[column.id].map((task) => <TaskBoardCard key={task.id} task={task} taskById={taskById} onOpen={openAnyTask} actions={renderCardActions(task)} meta={renderCardMeta(task, now)} blocker={queueBlockerByTaskId.get(task.id)} sourceLabel={taskSourceLabel(task)} />),
        }))}
      />
    )}
    {!tasks.isError && showDoneDrawerEntry ? <button className={styles.doneDrawerEntry} onClick={() => setDoneDrawerOpen(true)} title={t("查看已完成任务")}><IconChevronRight size="small" /><span>{t("已完成")}</span></button> : null}
    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建任务") : editing && taskIsRevisionDraft(editing) ? t("编辑第 {n} 轮草稿", { n: taskExecutionRound(editing) }) : t("编辑任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span>{editing !== "new" && editing ? <Button type="danger" theme="borderless" icon={<IconDelete />} onClick={() => setDeleting(editing)}>{t("删除")}</Button> : null}</span><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button type="primary" theme="solid" loading={actions.saveTask.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}>{editing !== "new" && editing && taskIsRevisionDraft(editing) ? <div className={`${styles.formNote} ${styles.revisionDraftNote}`}><span>{t("之前各轮的执行历史和最近退回原因已保留。")}</span><Button size="small" theme="borderless" onClick={() => openTaskHistory(editing, true)}>{t("查看历史")}</Button></div> : null}<label><span className={styles.titleFieldLabel}>{t("任务标题")}{generatingTitle && titleGenStatus ? <small className={styles.titleGenStatus}>{titleGenStatus}</small> : null}</span><div className={styles.titleInputRow}><Input autoFocus composition value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /><Button icon={<IconAIEditLevel1 />} aria-label={t("自动生成标题")} title={canAutoGenerateTaskTitle(draft.description) ? t("根据任务描述自动生成标题") : t("任务描述至少 {n} 字后可自动生成", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })} loading={generatingTitle} disabled={!canAutoGenerateTaskTitle(draft.description)} onClick={() => void autoGenerateTitle()} /></div>{!canAutoGenerateTaskTitle(draft.description) ? <small className={styles.titleGenerateHint}>{t("任务描述至少 {n} 字后可自动生成标题", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })}</small> : null}</label><label><span>{t("任务描述（可选）")}</span><TextArea composition value={draft.description} autosize={{ minRows: 9, maxRows: 12 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><div className={styles.formGrid}><label><span>{t("任务类型")}</span><Select value={draft.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, taskType: String(value) as ProjectTaskType }))} /></label><label><span>{t("Agent Profile")}</span><Select value={draft.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} onChange={(value) => setDraft((current) => ({ ...current, agentProfile: String(value) }))} /></label></div>{draft.baseTaskId ? <div className={styles.formNote}>{t("基于父任务：{id}（{title}）", { id: shortTaskId(draft.baseTaskId), title: taskById.get(draft.baseTaskId)?.title ?? t("已完成任务") })}</div> : null}</div>
    </SideSheet>
    <Modal title={t("删除任务“{name}”？", { name: deleting?.title ?? "" })} visible={deleting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okType="danger" okText={t("删除")} cancelText={t("取消")} maskClosable={false} onCancel={() => setDeleting(null)} onOk={() => void removeEditingTask()} okButtonProps={{ loading: actions.deleteTask.isPending }}>
      <div className={styles.form}><p>{t("删除后任务将从项目看板移除，此操作不可撤销。")}</p></div>
    </Modal>
    <TaskReadonlySideSheet task={viewing} remoteOrigin={viewing ? remoteOrigins.get(viewing.id) ?? null : null} ownedByOther={viewing ? taskOwnedByOtherDevice(viewing, taskById, currentDeviceId) : false} now={now} runningJobId={viewing?.id ? (runnerState?.current ?? []).find((info) => info.taskId === viewing.id)?.jobId ?? null : null} baseTask={viewing?.baseTaskId ? taskById.get(viewing.baseTaskId) ?? null : null} relatedTasks={viewing ? boardTasks.filter((child) => child.baseTaskId === viewing.id) : []} onOpenTask={openAnyTask} onClose={() => { setViewing(null); setHistoryReturnTaskId(null); }} onEditDraft={editDraftFromHistory} onApprove={(task) => void approveTask(task)} onReject={(task) => openReject(task)} onConvert={(task) => openConvert(task)} onCreateChildTask={(task) => createChildTask(task)} />
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
            {doneTree.roots.map((task) => renderDoneTask(task, 0, (clicked) => { setDoneDrawerOpen(false); openAnyTask(clicked); }))}
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

/** 最近一次执行是否被应用重启中断（Rust 启动恢复时在 execution_history 写入
 *  `interrupted: true`）。看板卡片据此在待处理列标注异常。 */
export function taskLastExecutionInterrupted(task: ProjectTask): boolean {
  const history = taskExecutionHistory(task);
  const last = history[history.length - 1];
  return Boolean(last?.interrupted);
}

/**
 * 任务是否归属其他设备（本机只能查看，不可执行 / 审核 / 编辑 / 建子任务）。
 *
 * 跨设备归属规则（与 Rust `list_queued_project_tasks` / `task_is_owned_by_other_device` 一致）：
 * - 任务被其他设备领取（claimedBy 非空且非本机）→ 正在被其他设备执行；
 * - 任务执行过（executionHistory 非空）但未标记为本机领取 → 工作区同步来的其他设备已执行任务；
 * - `lastJobId` 是本机执行时写入的设备本地字段（工作区同步不携带）：只要非空就说明任务
 *   在本机执行过，即使 `claimedBy` 因设备身份变化 / 数据库迁移与当前设备不一致，也不把
 *   本机执行过的任务误判为其他设备；
 * - 父任务归属其他设备（或本机没有父任务）→ 子任务跟随父任务归属。
 */
export function taskOwnedByOtherDevice(
  task: ProjectTask,
  taskById: Map<string, ProjectTask>,
  currentDeviceId: string | null,
): boolean {
  if (currentDeviceId != null && task.claimedBy === currentDeviceId) return false;
  // 本机执行过：lastJobId 是本机本地字段，即使 claimedBy 与当前设备不一致也不是其他设备任务。
  if (task.lastJobId) return false;
  if (currentDeviceId != null && task.claimedBy != null) return true;
  if (taskHasExecution(task)) return true;
  if (task.baseTaskId) {
    const parent = taskById.get(task.baseTaskId);
    if (!parent) return true;
    if (currentDeviceId != null && parent.claimedBy === currentDeviceId) return false;
    if (parent.lastJobId) return false;
    if (currentDeviceId != null && parent.claimedBy != null) return true;
    if (taskHasExecution(parent)) return true;
  }
  return false;
}

/** 任务 id 缩短展示：完整 id 是 UUID（36 字符），看板卡片等紧凑场景只展示后半段
 *  （第 4 段起，`xxxx-xxxxxxxxxxxx`），既保留可辨识度又避免侵占卡片空间。 */
function shortTaskId(id: string): string {
  const parts = id.split("-");
  if (parts.length >= 5) return `${parts[3]}-${parts[4]}`;
  return id.length <= 12 ? id : id.slice(-12);
}

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

/** 看板任务卡片。看板列与已完成抽屉共用，按状态分为两种布局：
 *  - 已完成：下方两行——标题（占一行或两行）+ 基础信息行（「类型 · Agent」弱化元信息 + 时间），
 *    无「基于」行（树内子任务由父任务卡片承载层级）；有子任务的父任务可展开/收缩。
 *  - 其他状态（待处理 / 进行中 / 待审核）：保持原有行结构——第一行合并元信息
 *    （执行轮次 代码修改 · Claude Code，执行轮次为唯一彩色标签），第二行标题，第三行「基于」（可选），第四行时间。
 *  待审核卡片左侧橙色强调线提示。depth > 0 表示作为已完成树内子任务渲染。 */
export function TaskCard({ task, taskById, onOpen, actions = [], meta, trailing, blocker, sourceLabel, depth = 0, expandable = false, expanded = false, childCount = 0, onToggleExpand, children }: { task: ProjectTask; taskById: Map<string, ProjectTask>; onOpen: (task: ProjectTask) => void; actions?: CardAction[]; meta: ReactNode; trailing?: ReactNode; blocker?: ProjectTaskQueueBlocker; sourceLabel?: string; depth?: number; expandable?: boolean; expanded?: boolean; childCount?: number; onToggleExpand?: () => void; children?: ReactNode }) {
  const { t } = useAppPreferences();
  const isReview = task.status === "review";
  const isDone = task.status === "done";
  // 进行中 / 待审核的交互动作统一收进右上角 ⋯ 菜单，右下角不再放单动作按钮
  // （该位置留给 token 消耗展示）。
  const menuRequired = task.status === "in_progress" || task.status === "review";
  // 基于任务（父任务）：仅独立展示的任务（depth 0）才渲染该行；已完成树内的子任务
  // 层级关系已由父任务卡片承载，不再重复展示。点击打开父任务信息，悬浮展示完整标题与 id。
  const parentTask = task.baseTaskId ? taskById.get(task.baseTaskId) : undefined;
  const baseRow = task.baseTaskId && depth === 0 ? (
    <div className={styles.taskCardBase}>
      {parentTask ? (
        <Tooltip
          position="topLeft"
          content={
            <div className={styles.taskCardBaseTip}>
              <div>{t("父任务标题")}：{parentTask.title}</div>
              <div>{t("父任务 ID")}：{parentTask.id}</div>
            </div>
          }
        >
          <button
            className={`${styles.taskTag} ${styles.taskTagBase} ${styles.taskTagBaseLink}`}
            onClick={(event) => { event.stopPropagation(); onOpen(parentTask); }}
          >
            {t("基于")}：{shortTaskId(task.baseTaskId)}
          </button>
        </Tooltip>
      ) : (
        <span className={`${styles.taskTag} ${styles.taskTagBase}`} title={task.baseTaskId}>{t("基于")}：{shortTaskId(task.baseTaskId)}</span>
      )}
    </div>
  ) : null;
  const expandControl = expandable ? (
    <button
      className={styles.taskCardExpand}
      aria-label={expanded ? t("收缩子任务") : t("展开子任务")}
      title={expanded ? t("收缩子任务") : t("展开子任务")}
      onClick={(event) => { event.stopPropagation(); onToggleExpand?.(); }}
    >
      <IconChevronRight size="small" className={expanded ? styles.taskCardExpandOpen : undefined} />
    </button>
  ) : null;
  // 交互动作：非进行中/待审核（menuRequired）状态的动作直接在卡片右下角展示按钮（常驻），
  // 多个动作并排显示（如已提交待执行的「置顶」+「撤回」）；
  // 进行中/待审核状态的动作统一收进右上角 ⋯ 菜单（悬停卡片时露出）。
  const directActions = !menuRequired && actions.length > 0 ? (
    <span className={styles.taskCardActionRow}>
      {actions.map((action) => (
        <button
          key={action.key}
          className={styles.taskCardAction}
          title={action.label}
          onClick={(event) => { event.stopPropagation(); action.onClick(); }}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </span>
  ) : null;
  const moreMenu = menuRequired && actions.length > 0 ? (
    <Dropdown
      position="bottomRight"
      trigger="click"
      clickToHide
      render={<Dropdown.Menu>{actions.map((action) => (
        <Dropdown.Item key={action.key} icon={action.icon} onClick={(event) => { event.stopPropagation(); action.onClick(); }}>{action.label}</Dropdown.Item>
      ))}</Dropdown.Menu>}
    >
      <button className={styles.taskCardMenu} aria-label={t("更多操作")} title={t("更多操作")} onClick={(event) => event.stopPropagation()}>
        <IconMore size="small" />
      </button>
    </Dropdown>
  ) : null;

  // 已完成布局：第一行标题（可含展开按钮/子任务计数），第二行基础信息。
  if (isDone) {
    return (
      <article className={`${styles.taskCard} ${isReview ? styles.taskCardReview : ""} ${depth > 0 ? styles.taskCardChild : ""}`}>
        <div className={styles.taskCardHead}>
          {expandControl}
          <div className={styles.taskTitle}>
            <button className={styles.taskTitleLink} title={t("查看任务详情")} onClick={() => onOpen(task)}>
              <strong>{task.title}</strong>
            </button>
          </div>
          {expandable && !expanded ? <span className={styles.taskCardChildCount}>{childCount}</span> : null}
          {moreMenu}
        </div>
        {baseRow}
        <div className={`${styles.taskCardMeta} ${styles.taskCardMetaRow}`}>
          <span className={styles.taskCardInfo}>
            {sourceLabel ? <span className={styles.remoteTaskTag}>{t("其他设备")} · {sourceLabel}</span> : <span className={styles.taskCardTypeAgent}>{t(taskTypeLabel(task.taskType))} · {task.agentProfile}</span>}
          </span>
          {meta}
        </div>
        {children}
      </article>
    );
  }

  // 其他状态布局：第一行合并元信息，第二行标题，第三行「基于」（可选），第四行时间。
  return (
    <ProjectsBoardTaskCardView
      review={isReview}
      classNames={{
        card: `${styles.taskCard} ${depth > 0 ? styles.taskCardChild : ""}`,
        review: styles.taskCardReview,
        head: styles.taskCardHead,
        tags: styles.taskTags,
        title: styles.taskTitle,
        titleStandalone: styles.taskTitleStandalone,
        footer: styles.taskCardMetaActions,
        meta: styles.taskCardMetaRight,
      }}
      tags={(
        <>
          <span className={`${styles.taskTag} ${styles.taskTagRound}`}>{taskIsRevisionDraft(task) ? t("第 {n} 轮草稿", { n: taskExecutionRound(task) }) : t("第 {n} 轮", { n: taskExecutionRound(task) })}</span>
          {sourceLabel ? <span className={styles.remoteTaskTag}>{t("其他设备")} · {sourceLabel}</span> : <span className={styles.taskCardTypeAgent}>{t(taskTypeLabel(task.taskType))} · {task.agentProfile}</span>}
        </>
      )}
      menu={moreMenu}
      title={(
        <button className={styles.taskTitleLink} title={isReview ? t("审核任务") : task.status === "draft" ? t("编辑任务") : t("查看任务详情")} onClick={() => onOpen(task)}>
          <strong>{task.title}</strong>
        </button>
      )}
      base={baseRow}
      blocker={blocker ? <div className={styles.taskBlocker}><Tag color="red" size="small">{t("无法执行")}</Tag><span>{blocker.message}</span></div> : null}
      meta={meta}
      trailing={directActions ?? trailing}
    >
      {children}
    </ProjectsBoardTaskCardView>
  );
}

/** 看板列中的普通任务卡片：在 TaskCard 之上按需挂载本轮 Token 消耗与预估费用
 *  （进行中 / 待审核展示在执行耗时行右侧，无 Token 数据时显示「消耗统计中」）。 */
function TaskBoardCard({ task, taskById, onOpen, actions, meta, blocker, sourceLabel }: { task: ProjectTask; taskById: Map<string, ProjectTask>; onOpen: (task: ProjectTask) => void; actions: CardAction[]; meta: ReactNode; blocker?: ProjectTaskQueueBlocker; sourceLabel?: string }) {
  const usage = useTaskTokenUsage(task);
  const trailing = !sourceLabel && (task.status === "in_progress" || task.status === "review")
    ? <TaskTokenSummary usage={usage.usage} flowletUsage={usage.flowletUsage} hasData={usage.hasData} />
    : undefined;
  return <TaskCard task={task} taskById={taskById} onOpen={onOpen} actions={actions} meta={meta} trailing={trailing} blocker={blocker} sourceLabel={sourceLabel} />;
}

/** 进行中 / 待审核任务的本轮 Token 消耗与预估费用：经最近一次执行的 background job
 *  解析出 Agent 会话 id，优先读取该会话的 Flowlet 观测用量（真实经代理的 token 与
 *  人民币预估费用）；无 Flowlet 观测记录时回退到原生会话用量摘要（仅 token，费用缺失）。
 *  进行中与看板整体刷新同节奏（每秒），待审核执行结束数据已定，只查一次。 */
function useTaskTokenUsage(task: ProjectTask): { usage: AgentSessionNativeUsage | null; flowletUsage: AgentSessionFlowletUsage | null; hasData: boolean } {
  const needsUsage = task.status === "in_progress" || task.status === "review";
  const history = useMemo(() => (needsUsage ? taskExecutionHistory(task) : []), [task, needsUsage]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  // 看板卡片与整体刷新同节奏（每秒）：进行中任务的 job 详情每秒更新一次。
  const jobDetail = useBackgroundTaskDetail(latestJobId, 1_000);
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  const agentType = projectAgentType(task.agentProfile);
  const isRunning = task.status === "in_progress";
  const enabled = needsUsage && Boolean(agentType) && Boolean(sessionId);
  // Flowlet 观测用量：真实经代理的 token 与预估费用（人民币）。
  const flowletQuery = useQuery({
    queryKey: queryKeys.agentSession.flowletUsage(agentType ?? "", sessionId ?? ""),
    queryFn: () => agentSessionCommands.flowletUsage(agentType!, sessionId!),
    enabled,
    refetchInterval: isRunning ? 1_000 : false,
    staleTime: isRunning ? 1_000 : 5 * 60_000,
    retry: 1,
  });
  // 原生会话用量：仅作为 Flowlet 观测缺失（会话未走代理）时的 token 回退。
  const nativeQuery = useQuery({
    queryKey: queryKeys.agentSession.nativeSummary(agentType ?? "", sessionId ?? ""),
    queryFn: () => agentSessionCommands.nativeSummary(agentType!, sessionId!),
    enabled,
    refetchInterval: isRunning ? 1_000 : false,
    staleTime: isRunning ? 1_000 : 5 * 60_000,
    retry: 1,
  });
  const flowletUsage = flowletQuery.data ?? null;
  const nativeUsage = nativeQuery.data?.usage ?? null;
  const hasFlowletData = Boolean(flowletUsage && flowletUsage.totalTokens > 0);
  const hasNativeTokens = Boolean(nativeUsage && nativeUsage.totalTokens > 0);
  return {
    usage: nativeUsage,
    flowletUsage,
    hasData: hasFlowletData || hasNativeTokens,
  };
}

/** 卡片右侧 Token 消耗文案：`1.8k tokens ≈¥0.03`；任务刚启动暂无 Token 数据时
 *  显示「消耗统计中」。费用优先取 Flowlet 观测的预估费用（人民币），缺失时回退
 *  原生会话的实际/等价费用。 */
function TaskTokenSummary({ usage, flowletUsage, hasData }: { usage: AgentSessionNativeUsage | null; flowletUsage: AgentSessionFlowletUsage | null; hasData: boolean }) {
  const { t } = useAppPreferences();
  const totalTokens = flowletUsage && flowletUsage.totalTokens > 0
    ? flowletUsage.totalTokens
    : usage && usage.totalTokens > 0 ? usage.totalTokens : 0;
  if (!hasData || totalTokens <= 0) {
    return <span className={styles.taskCardToken}>{t("消耗统计中")}</span>;
  }
  const tokenText = formatTaskTokenCount(totalTokens);
  // 预估费用：Flowlet 观测的人民币成本优先；
  // 回退原生会话 cost，再回退 apiEquivalent（API 等价价值）。
  const costAmount = flowletUsage && flowletUsage.estimatedCost > 0
    ? { amount: flowletUsage.estimatedCost, currency: "CNY" as const }
    : usage?.cost != null && Number.isFinite(usage.cost)
      ? { amount: usage.cost, currency: usage.costCurrency ?? "CNY" as const }
      : usage?.apiEquivalent?.amount != null && Number.isFinite(usage.apiEquivalent.amount)
        ? { amount: usage.apiEquivalent.amount, currency: usage.apiEquivalent.currency ?? "CNY" as const }
        : null;
  const costText = costAmount ? ` ≈${formatCostAmount(costAmount, 2)}` : "";
  return <span className={styles.taskCardToken} title={t("本轮执行 Token 消耗与预估费用")}>{`${tokenText} tokens${costText}`}</span>;
}

/** 卡片紧凑 Token 数呈现：`1.8k`、`12k`、`1.8M`，千以下保留整数。 */
function formatTaskTokenCount(tokens: number): string {
  const absolute = Math.abs(tokens);
  if (absolute >= 1_000_000) return `${trimScale((tokens / 1_000_000).toFixed(2))}M`;
  if (absolute >= 1_000) return `${trimScale((tokens / 1_000).toFixed(1))}k`;
  return String(Math.round(tokens));
}

/** 去掉缩放值尾部无意义的 `.0`（如 `12.0k` → `12k`）。 */
function trimScale(value: string): string {
  return value.replace(/\.0+$/, "");
}

/** 提交后任务的只读详情抽屉：概览（任务信息 + 运行/调度记录）+ 会话（完整对话）
 *  + 相关任务（基于本任务创建的子任务）。 */
function TaskReadonlySideSheet({ task, remoteOrigin, ownedByOther, now, runningJobId, baseTask, relatedTasks, onOpenTask, onClose, onEditDraft, onApprove, onReject, onConvert, onCreateChildTask }: { task: ProjectTask | null; remoteOrigin: RemoteTaskOrigin | null; ownedByOther: boolean; now: number; runningJobId: string | null; baseTask: ProjectTask | null; relatedTasks: ProjectTask[]; onOpenTask: (task: ProjectTask) => void; onClose: () => void; onEditDraft: (task: ProjectTask) => void; onApprove: (task: ProjectTask) => void; onReject: (task: ProjectTask) => void; onConvert: (task: ProjectTask) => void; onCreateChildTask: (task: ProjectTask) => void }) {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"overview" | "session" | "related">("overview");
  const [refreshing, setRefreshing] = useState(false);
  // 任务执行中在 Tabs 右上角使用页面公共的自动刷新控件：开关控制会话 Tab 的 5 秒自动刷新。
  const refreshControl = useRefreshControl({ intervalMs: SESSION_AUTO_REFRESH_MS });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | undefined>(undefined);
  // 概览累计执行耗时使用看板统一的实时时钟（TaskBoard 每秒推进），不再各自按秒刷新。
  // 执行历史按时间正序（history[0] 最早）。
  // 历史缺失（早期任务未记录 execution_history）但存在最近一次 job 时，回退为该次执行。
  const history = useMemo(() => (task ? taskExecutionHistory(task) : []), [task]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  // 与「会话」Tab 的 TaskSessionView 共享同一 query，用于刷新时解析 sessionId 精确失效时间线。
  const jobDetail = useBackgroundTaskDetail(latestJobId);
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  const agentType = task ? projectAgentType(task.agentProfile) : null;
  // 概览抽屉单独展示的退回原因：优先任务当前携带的 rejectionReason；被执行清空后
  // 回退到执行历史里最近一次被退回的原因（执行明细已不再重复展示具体原因）。
  const latestRejectionReason = useMemo(() => {
    if (!task) return null;
    if (task.rejectionReason) return task.rejectionReason;
    for (let i = history.length - 1; i >= 0; i--) {
      const record = history[i];
      if (record.rejected && record.rejectionReason) return record.rejectionReason;
    }
    return null;
  }, [task, history]);
  // 刷新按钮只在任务进行中时出现：此时执行记录与对话仍在增长，需要手动拉取最新状态。
  // 其他设备执行中的任务本机只读，不展示自动刷新控件。
  const isRunning = task?.status === "in_progress" && !remoteOrigin && !ownedByOther;
  // 切换任务时回到概览。
  useEffect(() => { setActiveTab("overview"); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isReview = task?.status === "review";
  const isDone = task?.status === "done";
  const isRevisionDraft = task ? taskIsRevisionDraft(task) : false;

  /** 与「会话详情抽屉」一致：按当前 Tab 刷新对应数据。概览刷新各次执行的 job 详情，会话刷新最近一次执行及其 Agent 时间线。 */
  const refreshActiveTab = async () => {
    setRefreshing(true);
    try {
      if (activeTab === "overview") {
        await Promise.all(history.map((record) => queryClient.invalidateQueries({ queryKey: queryKeys.backgroundTask.detail(record.jobId) })));
        return;
      }
      if (activeTab === "related") return;
      // 会话按执行轮次分 Tab：刷新所有历史轮次的 job 详情（重新解析各轮 sessionId），
      // 并精确失效最新一轮的时间线（其余轮次数据已完成，随 job 详情刷新即可）。
      const refetches: Promise<void>[] = history.map((record) => queryClient.invalidateQueries({ queryKey: queryKeys.backgroundTask.detail(record.jobId) }));
      // sessionId 缺失时（运行中尚未落库）只刷新 job 详情，TaskSessionView 会在拿到 sessionId 后自动加载时间线。
      if (agentType && sessionId) refetches.push(queryClient.invalidateQueries({ queryKey: queryKeys.agentSession.timeline(agentType, sessionId) }));
      await Promise.all(refetches);
      setLastUpdatedAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  };
  const footer = (
    <div className={styles.taskSheetFooter}><span></span><span className={styles.taskSheetFooterActions}>
      {isDone && task && !remoteOrigin && !ownedByOther ? <Button type="primary" theme="solid" onClick={() => onCreateChildTask(task)}>{t("基于此任务创建子任务")}</Button> : null}
      {isReview && task && !remoteOrigin && !ownedByOther ? (
        <>
          {task.taskType === "readonly" ? <Button onClick={() => onConvert(task)}>{t("转为代码修改")}</Button> : null}
          <Button onClick={() => onReject(task)}>{t("退回")}</Button>
          <Button type="primary" theme="solid" onClick={() => onApprove(task)}>{t("批准")}</Button>
        </>
      ) : null}
      {isRevisionDraft && task && !remoteOrigin && !ownedByOther ? <Button type="primary" theme="solid" onClick={() => onEditDraft(task)}>{t("继续编辑")}</Button> : null}
      <Button onClick={onClose}>{t("关闭")}</Button>
    </span></div>
  );

  return (
    <SideSheet
      visible={task != null}
      width={DETAIL_SHEET_WIDTH}
      motion={false}
      title={task ? <TaskReadonlyHeader task={task} remoteOrigin={remoteOrigin} /> : null}
      onCancel={onClose}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      footer={footer}
      bodyStyle={{
        padding: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {task ? (
        <div className={styles.drawer}>
          <Tabs
            type="line"
            activeKey={activeTab}
            tabPaneMotion={false}
            onChange={(key) => setActiveTab(key as "overview" | "session" | "related")}
            className={styles.taskReadonlyTabs}
            tabBarExtraContent={isRunning ? (
              <div className={styles.taskTabsRefresh}>
                <RefreshControl
                  autoRefresh={refreshControl.autoRefresh}
                  onToggleAutoRefresh={refreshControl.toggleAutoRefresh}
                  isFetching={refreshing || jobDetail.isFetching}
                  lastUpdatedAt={lastUpdatedAt}
                  intervalMs={refreshControl.intervalMs}
                  onRefresh={() => void refreshActiveTab()}
                  language={language}
                  t={t}
                />
              </div>
            ) : null}
          >
            <Tabs.TabPane tab={t("概览")} itemKey="overview">
              <div className={styles.tabFrame}>
                <div className={styles.tabScroll}>
                  <div className={styles.readonlyTabsBody}>
                    {remoteOrigin ? <div className={styles.remoteTaskNotice}>{t("这是来自“{device}”的只读任务快照，仅包含标题、状态和更新时间；编辑、审核及执行请在来源设备完成。", { device: remoteOrigin.deviceDisplayName })}</div> : null}
                    {!remoteOrigin && ownedByOther ? <div className={styles.remoteTaskNotice}>{t("该任务由其他设备执行，本机只读，请在执行设备上操作。")}</div> : null}
                    <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("任务信息")}</strong>
                      <div className={styles.readonlyGrid}>
                        <ReadonlyItem label={t("任务 ID")} value={task.id} copyable copyLabel={t("任务 ID")} />
                        {remoteOrigin ? (
                          <>
                            <ReadonlyItem label={t("来源设备")} value={remoteOrigin.deviceDisplayName} />
                            <ReadonlyItem label={t("任务更新时间")} value={formatTimestamp(task.updatedAt, language)} />
                            <ReadonlyItem label={t("快照更新时间")} value={formatTimestamp(remoteOrigin.snapshotUpdatedAt, language)} />
                          </>
                        ) : (
                          <>
                            <ReadonlyItem label={t("Agent 会话 ID")} value={sessionId ?? t("未执行")} copyable={Boolean(sessionId)} copyLabel={t("Agent 会话 ID")} />
                            <ReadonlyItem label={t("创建时间")} value={formatTimestamp(task.createdAt, language)} />
                            <ReadonlyItem label={t("更新时间")} value={formatTimestamp(task.updatedAt, language)} />
                            <ReadonlyItem label={t("总等待耗时")} value={formatElapsed(taskTotalWaitingDuration(task), language)} />
                            <ReadonlyItem label={t("总执行耗时")} value={formatElapsed(taskTotalExecutionDuration(task, runningJobId, now), language)} />
                            {baseTask ? <ReadonlyItem label={t("父任务 ID")} value={baseTask.id} copyable copyLabel={t("父任务 ID")} onClick={() => onOpenTask(baseTask)} /> : null}
                            {baseTask ? <ReadonlyItem label={t("父任务标题")} value={baseTask.title} wide /> : null}
                            {latestRejectionReason ? <ReadonlyItem label={t("退回原因")} value={latestRejectionReason} wide /> : null}
                            <ReadonlyItem label={t("任务描述")} value={task.description.trim() || t("无描述")} wide />
                          </>
                        )}
                      </div>
                    </section>
                    {!remoteOrigin ? <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("Agent 执行情况")}</strong>
                      {history.length === 0 ? <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无 Agent 执行记录")}</div> : (
                        <div className={styles.runRecordList}>
                          {history.map((record, index) => <TaskExecutionRun key={record.jobId} record={record} index={index} runningJobId={runningJobId} now={now} />)}
                        </div>
                      )}
                    </section> : null}
                  </div>
                </div>
              </div>
            </Tabs.TabPane>
            {!remoteOrigin ? <Tabs.TabPane tab={t("会话")} itemKey="session">
              <div className={styles.tabFrame}>
                <TaskSessionView
                  task={task}
                  visible={activeTab === "session"}
                  autoRefresh={refreshControl.autoRefresh}
                  onRefreshed={() => setLastUpdatedAt(Date.now())}
                />
              </div>
            </Tabs.TabPane> : null}
            {relatedTasks.length > 0 ? (
              <Tabs.TabPane tab={t("相关任务")} itemKey="related">
                <div className={styles.tabFrame}>
                  <div className={styles.tabScroll}>
                    <div className={styles.readonlyTabsBody}>
                      <div className={styles.relatedTaskList}>
                        {relatedTasks.map((child) => (
                          <button key={child.id} className={styles.relatedTaskItem} onClick={() => onOpenTask(child)}>
                            <span className={styles.relatedTaskMain}>
                              <span className={statusTagClass(child.status)}>{t(statusTagLabel(child.status))}</span>
                              <strong title={child.title}>{child.title}</strong>
                            </span>
                            <code>{shortTaskId(child.id)}</code>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </Tabs.TabPane>
            ) : null}
          </Tabs>
        </div>
      ) : null}
    </SideSheet>
  );
}

/** 单次执行的运行/调度记录：job 状态、起止时间与运行事件（不含 Agent 输出正文）。 */
function TaskExecutionRun({ record, index, runningJobId, now }: { record: TaskExecutionRecord; index: number; runningJobId: string | null; now: number }) {
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
  // 本轮等待 / 执行耗时：waitingMs / executionMs 优先，旧数据缺失时回退时间差；进行中轮次执行耗时实时增长。
  const waitingMs = taskRecordWaitingDuration(record);
  const executionMs = taskRecordExecutionDuration(record, runningJobId, now);
  const durationText = [
    waitingMs != null ? t("等待 {time}", { time: formatElapsed(waitingMs, language) }) : null,
    executionMs != null ? t("执行 {time}", { time: formatElapsed(executionMs, language) }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <article className={styles.runRecord}>
      <header className={styles.runRecordHead}>
        <span className={styles.runRecordTitle}>
          <strong>{t("第 {n} 次执行", { n: index + 1 })}</strong>
          {durationText ? <span className={styles.runRecordDuration}>{durationText}</span> : null}
        </span>
        <span className={styles.runRecordBadges}>
          {record.rejected ? <Tag size="small" color="red">{t("已退回")}</Tag> : null}
          {record.interrupted ? (
            <Tooltip content={t("应用重启导致本次执行中断，任务已回到待处理并自动重新排队")}>
              <Tag size="small" color="orange">{t("已中断")}</Tag>
            </Tooltip>
          ) : null}
          {job ? <JobStatusTag status={job.status} t={t} /> : null}
        </span>
      </header>
      {state ? <div className={styles.readonlyEmpty}>{state}</div> : null}
      <div className={styles.runRecordMeta}>
        {job ? <span>{t("开始 {time}", { time: formatTimestamp(job.startedAt ?? job.createdAt, language) })}</span> : null}
        {job?.finishedAt ? <span>{t("结束 {time}", { time: formatTimestamp(job.finishedAt, language) })}</span> : null}
        {record.rejected && record.rejectedAt ? <span>{t("退回 {time}", { time: formatTimestamp(record.rejectedAt, language) })}</span> : null}
        {job?.stage ? <span className={styles.runRecordStage}>{job.stage}</span> : null}
      </div>
      {job?.errorMessage ? <div className={styles.readonlyJobError}>{job.errorMessage}</div> : null}
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

/** 任务「会话」Tab：按执行轮次分 Tab 隔离展示每一轮产生的 Agent 会话，
 *  并且是懒加载——visible 为 false（外层「会话」Tab 未激活）时整块不渲染，不拉取任何
 *  轮次的 job/时间线；visible 后使用 tabList 只挂载当前轮次内容，切换时直接卸载旧轮次。
 *  每轮查询还携带执行开始 / 结束时间窗，后端只返回该轮交互，不再把复用 session id 的
 *  累积会话重复渲染到每个 Tab。这样大会话只在该轮被查看时才加载和进入 DOM。
 *  默认激活最后一轮（最新一轮）；autoRefresh 由外层公共刷新控件控制，仅作用于最新
 *  一轮（任务执行中只有它的对话在增长）；onRefreshed 在自动刷新成功后触发，供外层
 *  抽屉更新「最后刷新」指示。 */
function TaskSessionView({ task, visible, autoRefresh, onRefreshed }: { task: ProjectTask; visible: boolean; autoRefresh: boolean; onRefreshed?: () => void }) {
  const { t } = useAppPreferences();
  const history = useMemo(() => taskExecutionHistory(task), [task]);
  const isRunning = task.status === "in_progress";
  const agentType = projectAgentType(task.agentProfile);
  // 默认激活最新一轮；进入会话 Tab 或切换任务时回到最新一轮；查看期间新增轮次保留当前选择。
  const [activeRound, setActiveRound] = useState(() => Math.max(0, history.length - 1));
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) setActiveRound(Math.max(0, history.length - 1));
    wasVisibleRef.current = visible;
  }, [visible, history.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActiveRound(Math.max(0, history.length - 1)); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  // 懒加载：会话 Tab 未激活时不挂载轮次 Tabs，避免提前拉取和渲染大对话。
  if (!visible) return null;
  if (history.length === 0) {
    return (
      <div className={styles.tabScroll}>
        <div className={styles.taskSessionBody}>
          <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无会话记录")}</div>
        </div>
      </div>
    );
  }
  const activeIndex = Math.min(Math.max(activeRound, 0), history.length - 1);
  const activeRecord = history[activeIndex];
  const activeEndedAt = activeRecord.finishedAt ?? history[activeIndex + 1]?.startedAt ?? null;

  return (
    <div className={styles.roundTabs}>
      <Tabs
        type="line"
        activeKey={String(activeIndex)}
        tabPaneMotion={false}
        tabList={history.map((_, index) => ({
          itemKey: String(index),
          tab: t("第 {n} 轮", { n: index + 1 }),
        }))}
        onChange={(key) => setActiveRound(Number(key))}
      >
        <div key={activeRecord.jobId} className={styles.tabFrame}>
          <TaskSessionRound
            record={activeRecord}
            endedAt={activeEndedAt}
            agentType={agentType}
            roundIndex={activeIndex}
            autoRefresh={autoRefresh && isRunning && activeIndex === history.length - 1}
            onRefreshed={() => onRefreshedRef.current?.()}
          />
        </div>
      </Tabs>
    </div>
  );
}

/** 单轮执行的会话展示：读取该轮 job 产生的 Agent 会话时间线并渲染完整对话。
 *  懒加载下该组件只在「会话」Tab 可见且本轮为激活轮次时挂载，
 *  挂载即激活：测量真实滚动位置并聚焦滚动容器，让 PgUp/PgDn/End 等键盘操作立即可用；
 *  autoRefresh 仅对最新一轮开启（任务执行中对话仍在增长）。 */
function TaskSessionRound({ record, endedAt, agentType, roundIndex, autoRefresh, onRefreshed }: {
  record: TaskExecutionRecord;
  endedAt: string | null;
  agentType: "claude-code" | "opencode" | "pi" | "codex-cli" | null;
  roundIndex: number;
  autoRefresh: boolean;
  onRefreshed?: () => void;
}) {
  const { language, t } = useAppPreferences();
  const jobDetail = useBackgroundTaskDetail(record.jobId);
  // 运行中的任务 summary_json 尚无 sessionId（完成后才写入），回退从 job 的「会话」事件解析。
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  // 下界优先使用进入待处理的时刻：它早于子进程创建，可覆盖进程刚启动便写入首条用户消息的竞态；
  // 旧记录没有 submittedAt 时再回退到实际开始时刻。
  const timelineRange = useMemo(
    () => ({ startedAt: record.submittedAt ?? record.startedAt, endedAt }),
    [record.submittedAt, record.startedAt, endedAt],
  );
  const timeline = useAgentSessionTimeline(agentType, sessionId, Boolean(sessionId), timelineRange);
  // 完整对话的滚动跟随：在底部时新内容自动滚到底，离开底部时右下角出现滚动按钮
  // 并用红点提示新内容（与移动端会话弹窗一致）。
  const sessionScroll = useSessionScrollFollow<HTMLDivElement>();
  const conversationVersion = useMemo(
    () => interactionEventsVersion(timeline.data?.events ?? []),
    [timeline.data],
  );
  useLayoutEffect(() => {
    sessionScroll.observeContent(conversationVersion);
  }, [sessionScroll.observeContent, conversationVersion]);
  // 挂载即为当前轮次：重新测量滚动位置并聚焦滚动容器，标准键盘滚动立即可用。
  useLayoutEffect(() => {
    sessionScroll.handleScroll();
    sessionScroll.containerRef.current?.focus({ preventScroll: true });
  }, [sessionScroll.handleScroll, sessionScroll.containerRef]);
  // 任务执行中对话仍在增长：自动刷新开启时每 5 秒刷新完整对话；页面不可见时跳过。
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  useEffect(() => {
    if (!autoRefresh || !sessionId) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void timeline.refetch()
        .then(() => onRefreshedRef.current?.())
        .catch(() => undefined);
    }, SESSION_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, sessionId, timeline.refetch]);

  let content: ReactNode;
  if (jobDetail.isLoading) {
    content = <div className={styles.readonlyEmpty}>{t("正在读取执行记录…")}</div>;
  } else if (jobDetail.isError) {
    content = <div className={styles.readonlyEmpty}>{t("执行记录读取失败：{message}", { message: jobDetail.error.message })}</div>;
  } else if (!sessionId) {
    content = <div className={styles.readonlyEmpty}>{t("该任务执行未产生可展示的 Agent 会话")}</div>;
  } else {
    content = (
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

  return (
    <>
      <div
        ref={sessionScroll.containerRef}
        className={`${styles.tabScroll} ${styles.sessionScrollKeyboard}`}
        tabIndex={0}
        role="region"
        aria-label={t("第 {n} 轮会话内容", { n: roundIndex + 1 })}
        onScroll={sessionScroll.handleScroll}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, a, input, textarea, select, summary, [contenteditable='true'], [role='button']")) return;
          event.currentTarget.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          // 标准键盘滚动：会话滚动容器需要保持键盘焦点，否则 PgUp/PgDn/End 会落到
          // 文档根节点而不是容器。输入/可交互元素内保留原生按键语义，不劫持。
          const container = sessionScroll.containerRef.current;
          if (!container) return;
          const target = event.target as HTMLElement;
          if (target.closest("button, a, input, textarea, select, summary, [contenteditable='true'], [role='button']")) return;
          const step = Math.max(1, Math.round(container.clientHeight * 0.9));
          switch (event.key) {
            case "PageDown":
              container.scrollBy({ top: step });
              break;
            case "PageUp":
              container.scrollBy({ top: -step });
              break;
            case "Home":
              container.scrollTop = 0;
              break;
            case "End":
              container.scrollTop = container.scrollHeight;
              break;
            case " ":
              if (event.shiftKey) container.scrollBy({ top: -step }); else container.scrollBy({ top: step });
              break;
            default:
              return;
          }
          event.preventDefault();
          sessionScroll.handleScroll();
        }}
      >
        {/* 会话内容与概览 Tab 保持一致的内边距，避免内容贴边 */}
        <div className={styles.taskSessionBody}>
          {content}
        </div>
      </div>
      {!sessionScroll.atBottom ? (
        <ScrollBottomControl
          hasUnseenContent={sessionScroll.hasUnseenContent}
          ariaLabel={sessionScroll.hasUnseenContent ? t("有新内容，滚动到底部") : t("滚动到底部")}
          onClick={sessionScroll.scrollToBottom}
        />
      ) : null}
    </>
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
    // Claude Code / Pi 的会话 id 是 UUID；OpenCode 为 `ses_<...>` 前缀，分别识别。
    const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(event.message);
    if (uuid) return uuid[1];
    const opencode = /\b(ses_[A-Za-z0-9_-]+)\b/.exec(event.message);
    if (opencode) return opencode[1];
  }
  return null;
}

/** 任务 Agent Profile → 会话读取用的 agent_type。 */
function projectAgentType(agentProfile: string): "claude-code" | "opencode" | "pi" | "codex-cli" | null {
  if (agentProfile === "Claude Code") return "claude-code";
  if (agentProfile === "Codex") return "codex-cli";
  if (agentProfile === "OpenCode") return "opencode";
  if (agentProfile === "Pi") return "pi";
  return null;
}

function TaskReadonlyHeader({ task, remoteOrigin }: { task: ProjectTask; remoteOrigin: RemoteTaskOrigin | null }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.readonlyHeader}>
      <strong className={styles.readonlyHeaderTitle} title={task.title}>{task.title}</strong>
      <div className={styles.taskTags}>
        <span className={`${styles.taskTag} ${styles.taskTagRound}`}>{t("第 {n} 轮", { n: taskExecutionRound(task) })}</span>
        <span className={statusTagClass(task.status)}>{t(statusTagLabel(task.status))}</span>
        {remoteOrigin ? <span className={styles.remoteTaskTag}>{t("其他设备")} · {remoteOrigin.deviceDisplayName}</span> : (
          <>
            <span className={`${styles.taskTag} ${styles.taskTagType}`}>{t(taskTypeLabel(task.taskType))}</span>
            <span className={`${styles.taskTag} ${styles.taskTagAgent}`}>{task.agentProfile}</span>
          </>
        )}
      </div>
    </div>
  );
}

function ReadonlyItem({ label, value, wide = false, copyable = false, copyLabel, onClick }: { label: string; value: string; wide?: boolean; copyable?: boolean; copyLabel?: string; onClick?: () => void }) {
  const { t } = useAppPreferences();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{label} 已复制", { label: copyLabel ?? label }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  const valueNode = onClick ? <button className={styles.readonlyItemLink} title={value} onClick={onClick}>{value}</button> : <strong title={value}>{value}</strong>;
  return <div className={`${styles.readonlyItem} ${wide ? styles.readonlyItemWide : ""}`}><span>{label}</span><div className={styles.readonlyItemValue}>{valueNode}{copyable ? <button className={styles.readonlyItemCopy} aria-label={t("复制{label}", { label })} title={t("复制{label}", { label })} onClick={() => void copy()}><IconCopy size="extra-small" /></button> : null}</div></div>;
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
