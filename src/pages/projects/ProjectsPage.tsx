import { useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Popconfirm, Select, SideSheet, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { IconDelete, IconEdit, IconFolder, IconPlus } from "@douyinfe/semi-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useNavigate, useParams } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { Project, ProjectTask, ProjectTaskPriority, ProjectTaskStatus, ProjectTaskType } from "../../domains/project/types";
import { newProject, newProjectTask, useProject, useProjectActions, useProjects, useProjectTaskActions, useProjectTasks } from "../../features/projects/useProjects";
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
  const tasks = useProjectTasks(project.id, refresh.autoRefresh);
  return <main className={styles.page}>
    <PageHeader title={project.name} subtitle={project.directoryPath}>
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
    </PageHeader>
    <section className={styles.detailContent}>
      <TaskBoard project={project} tasks={tasks} />
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

function TaskBoard({ project, tasks }: { project: Project; tasks: ReturnType<typeof useProjectTasks> }) {
  const { t } = useAppPreferences();
  const actions = useProjectTaskActions(project.id);
  const [editing, setEditing] = useState<ProjectTask | "new" | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", taskType: "code" as ProjectTaskType, agentProfile: "Claude Code", priority: "p2" as ProjectTaskPriority });
  const grouped = useMemo(() => Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, tasks.data?.filter((task) => column.statuses.includes(task.status)) ?? []])) as Record<string, ProjectTask[]>, [tasks.data]);
  const openEditor = (task: ProjectTask | "new") => { setEditing(task); setDraft(task === "new" ? { title: "", description: "", taskType: "code", agentProfile: "Claude Code", priority: "p2" } : { title: task.title, description: task.description, taskType: task.taskType, agentProfile: task.agentProfile, priority: task.priority }); };
  const save = async () => {
    if (!editing || !draft.title.trim()) return;
    const task = editing === "new" ? { ...newProjectTask(project.id, draft.title), description: draft.description.trim(), taskType: draft.taskType, agentProfile: draft.agentProfile, priority: draft.priority } : { ...editing, ...draft, title: draft.title.trim(), description: draft.description.trim(), updatedAt: new Date().toISOString() };
    try { await actions.saveTask.mutateAsync(task); Toast.success(t("任务已保存")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  const changeStatus = async (task: ProjectTask, status: ProjectTaskStatus) => { try { await actions.saveTask.mutateAsync({ ...task, status, updatedAt: new Date().toISOString() }); } catch (error) { Toast.error(errorMessage(error)); } };
  const removeEditingTask = async () => {
    if (!editing || editing === "new") return;
    try { await actions.deleteTask.mutateAsync(editing.id); Toast.success(t("任务已删除")); setEditing(null); } catch (error) { Toast.error(errorMessage(error)); }
  };
  return <div className={styles.boardView}>
    {tasks.isError ? <div className={styles.state}>{tasks.error.message}</div> : <div className={`${styles.board} ${styles.taskBoard}`}>
      {TASK_COLUMNS.map((column) => <section className={styles.column} key={column.id}><header><span className={styles.colTitle}><span>{t(column.label)}</span><span className={styles.colCount}>{grouped[column.id].length}</span></span>{column.addable ? <button className={styles.addColButton} aria-label={t("添加任务")} title={t("添加任务")} onClick={() => openEditor("new")}><IconPlus /></button> : null}</header><div className={styles.columnBody}>
        {grouped[column.id].map((task) => {
          const isDraft = task.status === "draft";
          return <article className={styles.taskCard} key={task.id}><div className={styles.taskTags}><span className={`${styles.taskTag} ${styles.taskTagPriority}`}>{t(priorityLabel(task.priority))}</span><span className={isDraft ? styles.taskStatusDraft : styles.taskStatusSubmitted}>{isDraft ? t("未提交") : t("已提交")}</span><span className={`${styles.taskTag} ${styles.taskTagType}`}>{t(taskTypeLabel(task.taskType))}</span><span className={`${styles.taskTag} ${styles.taskTagAgent}`}>{task.agentProfile}</span></div><div className={styles.taskTitle}>{isDraft ? <button className={styles.taskTitleLink} title={t("编辑任务")} onClick={() => openEditor(task)}><strong>{task.title}</strong></button> : <strong>{task.title}</strong>}</div><button className={`${styles.taskCardAction} ${isDraft ? styles.taskCardSubmit : styles.taskCardWithdraw}`} onClick={() => void changeStatus(task, isDraft ? "submitted" : "draft")}>{isDraft ? t("提交") : t("撤回")}</button></article>;
        })}
        {column.addable ? <button className={styles.addCard} onClick={() => openEditor("new")}><IconPlus />{t("添加任务")}</button> : null}
      </div></section>)}
    </div>}
    <SideSheet visible={editing != null} width={DETAIL_SHEET_WIDTH} motion={false} title={editing === "new" ? t("新建任务") : t("编辑任务")} onCancel={() => setEditing(null)} zIndex={APP_OVERLAY_Z_INDEX.sideSheet} footer={<div className={styles.taskSheetFooter}><span>{editing !== "new" && editing ? <Popconfirm className={styles.taskDeletePopconfirm} title={t("删除任务“{name}”？", { name: editing.title })} okText={t("删除")} cancelText={t("取消")} okType="danger" onConfirm={() => void removeEditingTask()}><Button type="danger" theme="borderless" icon={<IconDelete />}>{t("删除")}</Button></Popconfirm> : null}</span><span className={styles.taskSheetFooterActions}><Button onClick={() => setEditing(null)}>{t("取消")}</Button><Button type="primary" theme="solid" loading={actions.saveTask.isPending} disabled={!draft.title.trim()} onClick={() => void save()}>{t("保存")}</Button></span></div>}>
      <div className={styles.form}><div className={styles.formRow}><label><span>{t("优先级")}</span><Select value={draft.priority} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} renderSelectedItem={(optionNode: { value?: string | number }) => String(optionNode.value ?? "").toUpperCase()} optionList={PRIORITIES.map((item) => ({ value: item.value, label: `${t(item.label)} · ${t(item.description)}` }))} onChange={(value) => setDraft((current) => ({ ...current, priority: String(value) as ProjectTaskPriority }))} /></label><label><span>{t("任务标题")}</span><Input autoFocus value={draft.title} maxLength={120} onChange={(title) => setDraft((current) => ({ ...current, title }))} /></label></div><label><span>{t("任务描述（可选）")}</span><TextArea value={draft.description} autosize={{ minRows: 3, maxRows: 6 }} onChange={(description) => setDraft((current) => ({ ...current, description }))} /></label><div className={styles.formGrid}><label><span>{t("任务类型")}</span><Select value={draft.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(value) => setDraft((current) => ({ ...current, taskType: String(value) as ProjectTaskType }))} /></label><label><span>{t("Agent Profile")}</span><Select value={draft.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} onChange={(value) => setDraft((current) => ({ ...current, agentProfile: String(value) }))} /></label></div></div>
    </SideSheet>
  </div>;
}

function taskTypeLabel(taskType: ProjectTaskType) { return taskType === "code" ? "代码修改" : "只读分析"; }

function priorityLabel(priority: ProjectTaskPriority) { return priority.toUpperCase(); }

