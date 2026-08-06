import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Empty, Input, Modal, Select, SideSheet, Tabs, Tag, TextArea, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconAIEditLevel1, IconChevronRight, IconCopy, IconDelete, IconEdit, IconExternalOpen, IconFolder, IconMore, IconPlus, IconRefresh, IconSearch, IconStop, IconTickCircle, IconUndo } from "@douyinfe/semi-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { BackgroundJobEvent } from "../../domains/background-task/types";
import { agentSessionCommands } from "../../domains/agent-session/commands";
import type { AgentSessionFlowletUsage, AgentSessionNativeUsage } from "../../domains/agent-session/types";
import { projectCommands } from "../../domains/project/commands";
import { MIN_TITLE_GENERATION_DESCRIPTION_LENGTH, canAutoGenerateTaskTitle, generateTaskTitle } from "../../domains/project/generateTaskTitle";
import type { Project, ProjectTask, ProjectTaskMutableStatus, ProjectTaskPriority, ProjectTaskRunnerState, ProjectTaskStatus, ProjectTaskType, TaskExecutionRecord } from "../../domains/project/types";
import { proxyCommands } from "../../domains/proxy/commands";
import { taskExecutionHistory, taskLatestExecutionDuration, taskRecordExecutionDuration, taskRecordWaitingDuration, taskTotalExecutionDuration, taskTotalWaitingDuration, taskWaitingDuration } from "../../domains/project/types";
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
  const refresh = useRefreshControl({ intervalMs: 1_000 });
  const tasks = useProjectTasks(project.id, refresh.autoRefresh, refresh.intervalMs);
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
        isFetching={tasks.isFetching || scheduler.runnerState.isFetching}
        lastUpdatedAt={Math.max(tasks.dataUpdatedAt, scheduler.runnerState.dataUpdatedAt)}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void tasks.refetch()}
        language={language}
        t={t}
      />
    </PageHeader>
    <section className={styles.detailContent}>
      <TaskBoard project={project} tasks={tasks} runnerState={scheduler.runnerState.data} search={search} />
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

/** 看板任务搜索：关键词过滤任务，匹配标题、任务 ID、描述、类型（值/中文标签）、
 *  Agent 与优先级（值/大写标签），不区分大小写。空关键词返回原列表。 */
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
    || task.priority.toLowerCase().includes(kw)
    || priorityLabel(task.priority).toLowerCase().includes(kw)
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

const AGENT_PROFILES = ["Claude Code", "OpenCode", "Pi"];

const PRIORITIES: Array<{ value: ProjectTaskPriority; label: string; description: string }> = [
  { value: "p0", label: "P0", description: "紧急" },
  { value: "p1", label: "P1", description: "高" },
  { value: "p2", label: "P2", description: "普通" },
];

function TaskBoard({ project, tasks, runnerState, search }: { project: Project; tasks: ReturnType<typeof useProjectTasks>; runnerState?: ProjectTaskRunnerState; search: string }) {
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
  // 标题流式生成过程中的实时进度（展示在「任务标题」名称右侧，缓解等待焦虑）。
  const [titleGenStatus, setTitleGenStatus] = useState<string | null>(null);
  const [doneDrawerOpen, setDoneDrawerOpen] = useState(false);
  // 已完成列中父任务卡片收缩/展开状态：子任务收缩到父任务卡片内展示，默认展开。
  const [collapsedDoneParents, setCollapsedDoneParents] = useState<Set<string>>(() => new Set());
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
  // 搜索过滤：关键词匹配标题 / 任务 ID / 描述 / 类型 / Agent / 优先级，空关键词返回全部。
  const searchKeyword = search.trim().toLowerCase();
  const filteredTasks = useMemo(() => filterProjectTasks(tasks.data ?? [], searchKeyword), [tasks.data, searchKeyword]);
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, filteredTasks.filter((task) => column.statuses.includes(task.status))])) as Record<string, ProjectTask[]>, [filteredTasks]);
  // 已完成任务（「已完成」列/抽屉）与任务 id → 任务 映射（展示「基于任务」关系、点击打开父任务、创建子任务提示）。
  const doneTasks = useMemo(() => filteredTasks.filter((task) => task.status === "done"), [filteredTasks]);
  const taskById = useMemo(() => new Map((tasks.data ?? []).map((task) => [task.id, task])), [tasks.data]);
  // 已完成任务树：baseTaskId 指向已完成任务的子任务收缩到父任务卡片中展示。
  // 父任务不在已完成列表（或不在当前搜索命中结果）中的任务作为独立根任务展示。
  const doneTree = useMemo(() => buildDoneTaskTree(doneTasks), [doneTasks]);
  // 搜索词命中不到任何任务时，看板整体显示空态；「已完成」抽屉入口在搜索下无匹配已完成任务时同样隐藏。
  const noSearchMatch = searchKeyword.length > 0 && filteredTasks.length === 0;
  const showDoneDrawerEntry = !showDoneColumn && !(searchKeyword.length > 0 && doneTasks.length === 0);
  const openEditor = (task: ProjectTask | "new", presetBaseTaskId: string | null = null) => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", taskType: "code", agentProfile: "Claude Code", priority: "p2", baseTaskId: presetBaseTaskId } : { title: task.title, description: task.description, taskType: task.taskType, agentProfile: task.agentProfile, priority: task.priority, baseTaskId: task.baseTaskId }); };
  // 打开任意任务：草稿进编辑抽屉，其余打开只读详情（父任务跳转 / 相关任务跳转共用）。
  const openAnyTask = (clicked: ProjectTask) => { if (clicked.status === "draft") openEditor(clicked); else setViewing(clicked); };
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
   *  单个动作直接在卡片右下角渲染按钮；多个动作收进右上角 ⋯ 菜单（悬停卡片时露出）。 */
  const renderCardActions = (task: ProjectTask): CardAction[] => {
    switch (task.status) {
      case "draft":
        return [{ key: "submit", label: t("提交"), icon: <IconTickCircle />, onClick: () => void toggleSubmitted(task, true) }];
      case "submitted":
        return [{ key: "withdraw", label: t("撤回"), icon: <IconUndo />, onClick: () => void toggleSubmitted(task, false) }];
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

  /** 卡片左下角时间标签：草稿显示创建时间，已提交显示等待时间，其余显示累计执行时间。
   *  已提交且上次执行被应用重启中断的任务，在时间标签前附加「上次执行中断」警示标记。 */
  const renderCardMeta = (task: ProjectTask, now: number): ReactNode => {
    switch (task.status) {
      case "draft":
        return <span className={styles.taskCardTime} title={formatFullTimestamp(task.createdAt, language)}>{t("创建于 {time}", { time: formatTimestamp(task.createdAt, language) })}</span>;
      case "submitted": {
        const waiting = taskWaitingDuration(task, now);
        const interrupted = taskLastExecutionInterrupted(task);
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
          </span>
        );
      }
      case "in_progress": {
        // 进行中取实时时钟（当前轮次未结束），具体到秒展示，随看板每秒刷新。
        const runningJobId = runnerState?.current?.taskId === task.id ? runnerState.current.jobId : null;
        const duration = taskLatestExecutionDuration(task, runningJobId, now);
        return <span className={styles.taskCardTime} title={t("本轮执行时间")}>{t("执行 {time}", { time: formatElapsedSeconds(duration) })}</span>;
      }
      case "review": {
        // 待审核取最近一轮的真实执行耗时（时间已定），保持原有分钟级呈现。
        const runningJobId = runnerState?.current?.taskId === task.id ? runnerState.current.jobId : null;
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
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : <div ref={boardRef} className={`${styles.board} ${styles.taskBoard}`} style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(${TASK_COLUMN_MIN_WIDTH}px, 1fr))` }}>
      {noSearchMatch ? <div className={styles.searchEmpty}><Empty title={t("没有匹配的任务")} description={t("试试搜索标题、任务 ID 或描述关键词")} /></div> : visibleColumns.map((column) => <section className={styles.column} key={column.id}><header><span className={styles.colTitle}><span>{t(column.label)}</span><span className={`${styles.colCount} ${columnCountClass(column.id)}`}>{grouped[column.id].length}</span></span>{column.addable ? <button className={styles.addColButton} aria-label={t("添加任务")} title={t("添加任务")} onClick={() => openEditor("new")}><IconPlus /></button> : null}</header><div className={styles.columnBody}>
        {column.id === "done"
          ? doneTree.roots.map((task) => renderDoneTask(task))
          : grouped[column.id].map((task) => <TaskBoardCard key={task.id} task={task} taskById={taskById} onOpen={openAnyTask} actions={renderCardActions(task)} meta={renderCardMeta(task, now)} />)}
        {column.addable ? <button className={styles.addCard} onClick={() => openEditor("new")}><IconPlus />{t("添加任务")}</button> : null}
      </div></section>)}
    </div>}
    {!tasks.isError && showDoneDrawerEntry ? <button className={styles.doneDrawerEntry} onClick={() => setDoneDrawerOpen(true)} title={t("查看已完成任务")}><IconChevronRight size="small" /><span>{t("已完成")}</span></button> : null}
    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建任务") : t("编辑任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span>{editing !== "new" && editing ? <Button type="danger" theme="borderless" icon={<IconDelete />} onClick={() => setDeleting(editing)}>{t("删除")}</Button> : null}</span><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button type="primary" theme="solid" loading={actions.saveTask.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}><div className={styles.formRow}><label><span>{t("优先级")}</span><Select value={draft.priority} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} renderSelectedItem={(optionNode: { value?: string | number }) => String(optionNode.value ?? "").toUpperCase()} optionList={PRIORITIES.map((item) => ({ value: item.value, label: `${t(item.label)} · ${t(item.description)}` }))} onChange={(value) => setDraft((current) => ({ ...current, priority: String(value) as ProjectTaskPriority }))} /></label><label><span className={styles.titleFieldLabel}>{t("任务标题")}{generatingTitle && titleGenStatus ? <small className={styles.titleGenStatus}>{titleGenStatus}</small> : null}</span><div className={styles.titleInputRow}><Input autoFocus value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /><Button icon={<IconAIEditLevel1 />} aria-label={t("自动生成标题")} title={canAutoGenerateTaskTitle(draft.description) ? t("根据任务描述自动生成标题") : t("任务描述至少 {n} 字后可自动生成", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })} loading={generatingTitle} disabled={!canAutoGenerateTaskTitle(draft.description)} onClick={() => void autoGenerateTitle()} /></div>{!canAutoGenerateTaskTitle(draft.description) ? <small className={styles.titleGenerateHint}>{t("任务描述至少 {n} 字后可自动生成标题", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })}</small> : null}</label></div><label><span>{t("任务描述（可选）")}</span><TextArea value={draft.description} autosize={{ minRows: 3, maxRows: 6 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><div className={styles.formGrid}><label><span>{t("任务类型")}</span><Select value={draft.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, taskType: String(value) as ProjectTaskType }))} /></label><label><span>{t("Agent Profile")}</span><Select value={draft.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} onChange={(value) => setDraft((current) => ({ ...current, agentProfile: String(value) }))} /></label></div>{draft.baseTaskId ? <div className={styles.formNote}>{t("基于父任务：{id}（{title}）", { id: shortTaskId(draft.baseTaskId), title: taskById.get(draft.baseTaskId)?.title ?? t("已完成任务") })}</div> : null}</div>
    </SideSheet>
    <Modal title={t("删除任务“{name}”？", { name: deleting?.title ?? "" })} visible={deleting != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okType="danger" okText={t("删除")} cancelText={t("取消")} maskClosable={false} onCancel={() => setDeleting(null)} onOk={() => void removeEditingTask()} okButtonProps={{ loading: actions.deleteTask.isPending }}>
      <div className={styles.form}><p>{t("删除后任务将从项目看板移除，此操作不可撤销。")}</p></div>
    </Modal>
    <TaskReadonlySideSheet task={viewing} now={now} runningJobId={viewing?.id ? (runnerState?.current?.taskId === viewing.id ? runnerState.current.jobId : null) : null} baseTask={viewing?.baseTaskId ? taskById.get(viewing.baseTaskId) ?? null : null} relatedTasks={viewing ? (tasks.data ?? []).filter((child) => child.baseTaskId === viewing.id) : []} onOpenTask={openAnyTask} onClose={() => setViewing(null)} onApprove={(task) => void approveTask(task)} onReject={(task) => openReject(task)} onConvert={(task) => openConvert(task)} onCreateChildTask={(task) => createChildTask(task)} />
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

/** 任务 id 缩短展示：完整 id 是 UUID（36 字符），看板卡片等紧凑场景只展示后半段
 *  （第 4 段起，`xxxx-xxxxxxxxxxxx`），既保留可辨识度又避免侵占卡片空间。 */
function shortTaskId(id: string): string {
  const parts = id.split("-");
  if (parts.length >= 5) return `${parts[3]}-${parts[4]}`;
  return id.length <= 12 ? id : id.slice(-12);
}

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

/** 列头数量徽标的背景色：待处理/进行中为主色，待审核为警示色，已完成为成功色。 */
function columnCountClass(columnId: string): string {
  switch (columnId) {
    case "review": return styles.colCountWarning;
    case "done": return styles.colCountSuccess;
    case "in_progress":
    case "backlog":
    default:
      return styles.colCountPrimary;
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
 *    不展示优先级，无「基于」行（树内子任务由父任务卡片承载层级）；有子任务的父任务可展开/收缩。
 *  - 其他状态（待处理 / 进行中 / 待审核）：保持原有行结构——第一行合并元信息
 *    （P2 代码修改 · Claude Code，P2 为唯一彩色标签），第二行标题，第三行「基于」（可选），第四行时间。
 *  待审核卡片左侧橙色强调线提示。depth > 0 表示作为已完成树内子任务渲染。 */
export function TaskCard({ task, taskById, onOpen, actions = [], meta, trailing, depth = 0, expandable = false, expanded = false, childCount = 0, onToggleExpand, children }: { task: ProjectTask; taskById: Map<string, ProjectTask>; onOpen: (task: ProjectTask) => void; actions?: CardAction[]; meta: ReactNode; trailing?: ReactNode; depth?: number; expandable?: boolean; expanded?: boolean; childCount?: number; onToggleExpand?: () => void; children?: ReactNode }) {
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
  // 交互动作：非进行中/待审核的单个动作直接在卡片右下角展示按钮（常驻）；
  // 多个动作以及进行中/待审核状态的动作统一收进右上角 ⋯ 菜单（悬停卡片时露出）。
  const singleAction = actions.length === 1 && !menuRequired ? (
    <button
      className={styles.taskCardAction}
      title={actions[0].label}
      onClick={(event) => { event.stopPropagation(); actions[0].onClick(); }}
    >
      {actions[0].icon}
      <span>{actions[0].label}</span>
    </button>
  ) : null;
  const moreMenu = actions.length > 1 || (menuRequired && actions.length > 0) ? (
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
            <span className={styles.taskCardTypeAgent}>{t(taskTypeLabel(task.taskType))} · {task.agentProfile}</span>
          </span>
          {meta}
        </div>
        {children}
      </article>
    );
  }

  // 其他状态布局：第一行合并元信息，第二行标题，第三行「基于」（可选），第四行时间。
  return (
    <article className={`${styles.taskCard} ${isReview ? styles.taskCardReview : ""} ${depth > 0 ? styles.taskCardChild : ""}`}>
      <div className={styles.taskCardHead}>
        <div className={styles.taskTags}>
          <span className={`${styles.taskTag} ${styles.taskTagPriority}`}>{t(priorityLabel(task.priority))}</span>
          <span className={styles.taskCardTypeAgent}>{t(taskTypeLabel(task.taskType))} · {task.agentProfile}</span>
        </div>
        {moreMenu}
      </div>
      <div className={`${styles.taskTitle} ${styles.taskTitleStandalone}`}>
        <button className={styles.taskTitleLink} title={isReview ? t("审核任务") : task.status === "draft" ? t("编辑任务") : t("查看任务详情")} onClick={() => onOpen(task)}>
          <strong>{task.title}</strong>
        </button>
      </div>
      {baseRow}
      {meta || singleAction || trailing ? <div className={styles.taskCardMetaActions}><span className={styles.taskCardMetaRight}>{meta}</span>{singleAction ?? trailing}</div> : null}
      {children}
    </article>
  );
}

/** 看板列中的普通任务卡片：在 TaskCard 之上按需挂载本轮 Token 消耗与预估费用
 *  （进行中 / 待审核展示在执行耗时行右侧，无 Token 数据时显示「消耗统计中」）。 */
function TaskBoardCard({ task, taskById, onOpen, actions, meta }: { task: ProjectTask; taskById: Map<string, ProjectTask>; onOpen: (task: ProjectTask) => void; actions: CardAction[]; meta: ReactNode }) {
  const usage = useTaskTokenUsage(task);
  const trailing = task.status === "in_progress" || task.status === "review"
    ? <TaskTokenSummary usage={usage.usage} flowletUsage={usage.flowletUsage} hasData={usage.hasData} />
    : undefined;
  return <TaskCard task={task} taskById={taskById} onOpen={onOpen} actions={actions} meta={meta} trailing={trailing} />;
}

/** 进行中 / 待审核任务的本轮 Token 消耗与预估费用：经最近一次执行的 background job
 *  解析出 Agent 会话 id，优先读取该会话的 Flowlet 观测用量（真实经代理的 token 与
 *  人民币预估费用）；无 Flowlet 观测记录时回退到原生会话用量摘要（仅 token，费用缺失）。
 *  进行中每 5s 刷新一次，待审核执行结束数据已定，只查一次。 */
function useTaskTokenUsage(task: ProjectTask): { usage: AgentSessionNativeUsage | null; flowletUsage: AgentSessionFlowletUsage | null; hasData: boolean } {
  const needsUsage = task.status === "in_progress" || task.status === "review";
  const history = useMemo(() => (needsUsage ? taskExecutionHistory(task) : []), [task, needsUsage]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  const jobDetail = useBackgroundTaskDetail(latestJobId);
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
    refetchInterval: isRunning ? 5_000 : false,
    staleTime: isRunning ? 3_000 : 5 * 60_000,
    retry: 1,
  });
  // 原生会话用量：仅作为 Flowlet 观测缺失（会话未走代理）时的 token 回退。
  const nativeQuery = useQuery({
    queryKey: queryKeys.agentSession.nativeSummary(agentType ?? "", sessionId ?? ""),
    queryFn: () => agentSessionCommands.nativeSummary(agentType!, sessionId!),
    enabled,
    refetchInterval: isRunning ? 5_000 : false,
    staleTime: isRunning ? 3_000 : 5 * 60_000,
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
function TaskReadonlySideSheet({ task, now, runningJobId, baseTask, relatedTasks, onOpenTask, onClose, onApprove, onReject, onConvert, onCreateChildTask }: { task: ProjectTask | null; now: number; runningJobId: string | null; baseTask: ProjectTask | null; relatedTasks: ProjectTask[]; onOpenTask: (task: ProjectTask) => void; onClose: () => void; onApprove: (task: ProjectTask) => void; onReject: (task: ProjectTask) => void; onConvert: (task: ProjectTask) => void; onCreateChildTask: (task: ProjectTask) => void }) {
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
      if (activeTab === "related") return;
      const refetches: Promise<void>[] = [];
      if (latestJobId) refetches.push(queryClient.invalidateQueries({ queryKey: queryKeys.backgroundTask.detail(latestJobId) }));
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
        <div className={styles.drawer}>
          {/* 抽屉顶部固定行：任务执行中展示页面公共的自动刷新控件 */}
          {isRunning ? (
            <div className={styles.drawerToolbar}>
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
          <Tabs
            type="line"
            activeKey={activeTab}
            tabPaneMotion={false}
            onChange={(key) => setActiveTab(key as "overview" | "session" | "related")}
            className={styles.taskReadonlyTabs}
          >
            <Tabs.TabPane tab={t("概览")} itemKey="overview">
              <div className={styles.tabFrame}>
                <div className={styles.tabScroll}>
                  <div className={styles.readonlyTabsBody}>
                    <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("任务信息")}</strong>
                      <div className={styles.readonlyGrid}>
                        <ReadonlyItem label={t("任务 ID")} value={task.id} copyable copyLabel={t("任务 ID")} />
                        <ReadonlyItem label={t("Agent 会话 ID")} value={sessionId ?? t("未执行")} copyable={Boolean(sessionId)} copyLabel={t("Agent 会话 ID")} />
                        <ReadonlyItem label={t("创建时间")} value={formatTimestamp(task.createdAt, language)} />
                        <ReadonlyItem label={t("更新时间")} value={formatTimestamp(task.updatedAt, language)} />
                        <ReadonlyItem label={t("总等待耗时")} value={formatElapsed(taskTotalWaitingDuration(task), language)} />
                        <ReadonlyItem label={t("总执行耗时")} value={formatElapsed(taskTotalExecutionDuration(task, runningJobId, now), language)} />
                        {baseTask ? <ReadonlyItem label={t("父任务 ID")} value={baseTask.id} copyable copyLabel={t("父任务 ID")} onClick={() => onOpenTask(baseTask)} /> : null}
                        {baseTask ? <ReadonlyItem label={t("父任务标题")} value={baseTask.title} wide /> : null}
                        {latestRejectionReason ? <ReadonlyItem label={t("退回原因")} value={latestRejectionReason} wide /> : null}
                        <ReadonlyItem label={t("任务描述")} value={task.description.trim() || t("无描述")} wide />
                      </div>
                    </section>
                    <section className={styles.readonlySection}><strong className={styles.readonlySectionTitle}>{t("Agent 执行情况")}</strong>
                      {history.length === 0 ? <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无 Agent 执行记录")}</div> : (
                        <div className={styles.runRecordList}>
                          {history.map((record, index) => <TaskExecutionRun key={record.jobId} record={record} index={index} runningJobId={runningJobId} now={now} />)}
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              </div>
            </Tabs.TabPane>
            <Tabs.TabPane tab={t("会话")} itemKey="session">
              <div className={styles.tabFrame}>
                <TaskSessionView
                  task={task}
                  autoRefresh={refreshControl.autoRefresh}
                  onRefreshed={() => setLastUpdatedAt(Date.now())}
                />
              </div>
            </Tabs.TabPane>
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

/** 任务「会话」Tab：读取最近一次执行产生的 Agent 会话，展示完整对话（全部交互）。
 *  autoRefresh 由外层公共刷新控件控制；onRefreshed 在自动刷新成功后触发，
 * 供外层抽屉更新「最后刷新」指示。 */
function TaskSessionView({ task, autoRefresh, onRefreshed }: { task: ProjectTask; autoRefresh: boolean; onRefreshed?: () => void }) {
  const { language, t } = useAppPreferences();
  const history = useMemo(() => taskExecutionHistory(task), [task]);
  const latestJobId = history.length > 0 ? history[history.length - 1].jobId : null;
  const jobDetail = useBackgroundTaskDetail(latestJobId);
  // 运行中的任务 summary_json 尚无 sessionId（完成后才写入），回退从 job 的「会话」事件解析。
  const sessionId = parseJobSessionId(jobDetail.data?.job.summaryJson ?? null)
    ?? parseSessionIdFromEvents(jobDetail.data?.events ?? []);
  const agentType = projectAgentType(task.agentProfile);
  const timeline = useAgentSessionTimeline(agentType, sessionId, Boolean(sessionId));
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
  // 任务执行中对话仍在增长：自动刷新开启时每 5 秒刷新完整对话；页面不可见时跳过。
  const isRunning = task.status === "in_progress";
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  useEffect(() => {
    if (!isRunning || !sessionId || !autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void timeline.refetch()
        .then(() => onRefreshedRef.current?.())
        .catch(() => undefined);
    }, SESSION_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, sessionId, autoRefresh, timeline.refetch]);

  let content: ReactNode;
  if (!latestJobId) {
    content = <div className={styles.readonlyEmpty}>{t("该任务尚未执行，暂无会话记录")}</div>;
  } else if (jobDetail.isLoading) {
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
        className={styles.tabScroll}
        onScroll={sessionScroll.handleScroll}
      >
        {content}
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

