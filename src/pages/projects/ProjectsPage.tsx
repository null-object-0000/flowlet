import { useMemo, useState } from "react";
import { Button, Dropdown, Empty, Input, Modal, Select, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconDelete, IconEdit, IconFolder, IconPlus } from "@douyinfe/semi-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useNavigate, useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionRow, AgentSessionRuntimeStatus } from "../../domains/agent-session/types";
import type { Project, ProjectTask, ProjectTaskStatus } from "../../domains/project/types";
import { useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import { newProject, newProjectTask, useProject, useProjectActions, useProjects, useProjectTaskActions, useProjectTasks } from "../../features/projects/useProjects";
import { errorMessage } from "../../shared/errors/AppError";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "../agent-sessions/AgentSessionDetailSideSheet";
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

function ProjectDetail({ projectId }: { projectId: string }) {
  const { t } = useAppPreferences();
  const navigate = useNavigate();
  const project = useProject(projectId);
  if (project.isLoading) return <main className={styles.page}><div className={styles.state}>{t("正在读取项目…")}</div></main>;
  if (project.isError || !project.data) return <main className={styles.page}><div className={styles.state}><strong>{t("项目不存在或加载失败")}</strong><Button onClick={() => navigate("/projects")}>{t("返回项目列表")}</Button></div></main>;
  return <LoadedProjectDetail project={project.data} />;
}

function LoadedProjectDetail({ project }: { project: Project }) {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 15_000 });
  const [view, setView] = useState<"sessions" | "tasks">("sessions");
  const sessions = useAgentSessions({ page: 1, pageSize: 500, search: "", agentType: "", runtimeStatus: "", projectPath: project.directoryPath }, refresh.autoRefresh);
  const tasks = useProjectTasks(project.id, refresh.autoRefresh);
  const activeQuery = view === "sessions" ? sessions : tasks;
  return <main className={styles.page}>
    <PageHeader title={<ProjectViewTitlePicker projectName={project.name} view={view} onChange={setView} />} subtitle={project.directoryPath}>
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={activeQuery.isFetching}
        lastUpdatedAt={activeQuery.dataUpdatedAt}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void activeQuery.refetch()}
        language={language}
        t={t}
      />
    </PageHeader>
    <section className={styles.detailContent}>
      {view === "sessions" ? <SessionBoard sessions={sessions} /> : <TaskBoard project={project} tasks={tasks} />}
    </section>
  </main>;
}

function ProjectViewTitlePicker({ projectName, view, onChange }: {
  projectName: string;
  view: "sessions" | "tasks";
  onChange: (view: "sessions" | "tasks") => void;
}) {
  const { t } = useAppPreferences();
  const viewLabel = view === "sessions" ? t("会话") : t("任务");
  return <Dropdown
    position="bottomLeft"
    trigger="click"
    clickToHide
    render={<Dropdown.Menu>
      <Dropdown.Item active={view === "sessions"} onClick={() => onChange("sessions")}>{t("会话")}</Dropdown.Item>
      <Dropdown.Item active={view === "tasks"} onClick={() => onChange("tasks")}>{t("任务")}</Dropdown.Item>
    </Dropdown.Menu>}
  >
    <button type="button" className={styles.viewTitleTrigger} aria-label={t("切换项目视角，当前：{name}", { name: viewLabel })}>
      <span>{projectName} · {viewLabel}</span>
      <IconChevronDown />
    </button>
  </Dropdown>;
}

const SESSION_COLUMNS: Array<{ status: AgentSessionRuntimeStatus; label: string; color: "green" | "orange" | "grey" }> = [
  { status: "running", label: "自动运行中", color: "green" }, { status: "waiting_user", label: "等待用户确认", color: "orange" },
  { status: "idle", label: "空闲", color: "grey" }, { status: "unknown", label: "无法判断", color: "grey" },
];

function SessionBoard({ sessions }: { sessions: ReturnType<typeof useAgentSessions> }) {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<AgentSessionRow | null>(null);
  const grouped = useMemo(() => Object.fromEntries(SESSION_COLUMNS.map(({ status }) => [status, sessions.data?.rows.filter((row) => row.runtimeStatus === status) ?? []])) as Record<AgentSessionRuntimeStatus, AgentSessionRow[]>, [sessions.data]);
  return <div className={styles.boardView}>
    {sessions.isError ? <div className={styles.state}>{sessions.error.message}</div> : <div className={styles.board}>
      {SESSION_COLUMNS.map((column) => <section className={styles.column} key={column.status}><header><span>{t(column.label)}</span><Tag color={column.color} size="small">{grouped[column.status].length}</Tag></header><div className={styles.columnBody}>
        {grouped[column.status].map((session) => <button className={styles.sessionCard} key={`${session.agentType}:${session.sessionId}`} onClick={() => setSelected(session)}><strong>{sessionDisplayTitle(session)}</strong><small className={styles.sessionMeta}>{formatTimestamp(session.activityAt, language)}<span> · {agentLabel(session.agentType)}</span></small></button>)}
        {!sessions.isLoading && grouped[column.status].length === 0 ? <div className={styles.columnEmpty}>{t("暂无会话")}</div> : null}
      </div></section>)}
    </div>}
    {selected ? <AgentSessionDetailSideSheet session={selected} onClose={() => setSelected(null)} onViewRequestLogs={(sessionId) => navigate(`/logs?search=${encodeURIComponent(sessionId)}`)} onRefreshOverview={async () => { await sessions.refetch(); }} /> : null}
  </div>;
}

const TASK_COLUMNS: Array<{ status: ProjectTaskStatus; label: string }> = [{ status: "todo", label: "待处理" }, { status: "in_progress", label: "进行中" }, { status: "done", label: "已完成" }];

function TaskBoard({ project, tasks }: { project: Project; tasks: ReturnType<typeof useProjectTasks> }) {
  const { t } = useAppPreferences();
  const actions = useProjectTaskActions(project.id);
  const [editing, setEditing] = useState<ProjectTask | "new" | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", status: "todo" as ProjectTaskStatus });
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map(({ status }) => [status, tasks.data?.filter((task) => task.status === status) ?? []])) as Record<ProjectTaskStatus, ProjectTask[]>, [tasks.data]);
  const openEditor = (task: ProjectTask | "new", status: ProjectTaskStatus = "todo") => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", status } : { title: task.title, description: task.description, status: task.status }); };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    const task = editing === "new" ? { ...newProjectTask(project.id, draft.title), description: draft.description.trim(), status: draft.status } : { ...editing, ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() };
    try { await actions.saveTask.mutateAsync(task); Toast.success(t("任务已保存")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  const changeStatus = async (task: ProjectTask, status: ProjectTaskStatus) => { try { await actions.saveTask.mutateAsync({ ...task, status, updatedAt: new Date().toISOString() }); } catch (error) { Toast.error(errorMessage(error)); } };
  const remove = (task: ProjectTask) => Modal.confirm({ title: t("删除任务“{name}”？", { name: task.title }), zIndex: APP_OVERLAY_Z_INDEX.modal, okType: "danger", onOk: () => actions.deleteTask.mutateAsync(task.id) });
  return <div className={styles.boardView}>
    <div className={styles.taskActions}><Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => openEditor("new")}>{t("新建任务")}</Button></div>
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : <div className={`${styles.board} ${styles.taskBoard}`}>
      {TASK_COLUMNS.map((column) => <section className={styles.column} key={column.status}><header><span>{t(column.label)}</span><Tag size="small">{grouped[column.status].length}</Tag></header><div className={styles.columnBody}>
        {grouped[column.status].map((task) => <article className={styles.taskCard} key={task.id}><div className={styles.taskTitle}><strong>{task.title}</strong><div><Button theme="borderless" icon={<IconEdit />} onClick={() => openEditor(task)} /><Button theme="borderless" type="danger" icon={<IconDelete />} onClick={() => remove(task)} /></div></div>{task.description ? <p>{task.description}</p> : null}<Select size="small" value={task.status} optionList={TASK_COLUMNS.map((item) => ({ value: item.status, label: t(item.label) }))} onChange={(value) => void changeStatus(task, value as ProjectTaskStatus)} /></article>)}
        <button className={styles.addCard} onClick={() => openEditor("new", column.status)}><IconPlus />{t("添加任务")}</button>
      </div></section>)}
    </div>}
    <Modal title={editing === "new" ? t("新建任务") : t("编辑任务")} visible={editing != null} zIndex={APP_OVERLAY_Z_INDEX.modal} okText={t("保存")} cancelText={t("取消")} onCancel={() => setEditing(null)} onOk={() => void save()} okButtonProps={{ loading: actions.saveTask.isPending, disabled: !draft.title.trim() }}>
      <div className={styles.form}><label><span>{t("任务标题")}</span><Input autoFocus value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /></label><label><span>{t("任务描述（可选）")}</span><TextArea value={draft.description} autosize={{ minRows: 3, maxRows: 6 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><label><span>{t("状态")}</span><Select value={draft.status} optionList={TASK_COLUMNS.map((item) => ({ value: item.status, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, status: value as ProjectTaskStatus }))} /></label></div>
    </Modal>
  </div>;
}

function agentLabel(agentType: AgentSessionRow["agentType"]) { return ({ "codex-desktop": "Codex Desktop", "codex-cli": "Codex CLI", "claude-code": "Claude Code", opencode: "OpenCode", pi: "Pi" } as const)[agentType]; }
