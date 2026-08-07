import { IconPlus } from "@douyinfe/semi-icons";
import { Tag } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedDeviceProject, SyncedProjectTask } from "../../domains/device-sync/types";
import { executionRoundFromCount, type ProjectTaskStatus } from "../../domains/project/types";
import { useMobileProjects } from "../../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp, type TimestampLanguage } from "../../shared/formatters/datetime";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
import { MobileProjectTitlePicker } from "../MobileProjectTitlePicker";
import { MobileTaskComposeSheet } from "../MobileTaskComposeSheet";
import { groupMobileProjects } from "../groupMobileProjects";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobilePullToRefresh } from "../MobilePullToRefresh";
import { MobileTaskDetailSheet } from "../MobileTaskDetailSheet";
import styles from "./MobilePage.module.css";

type TaskStatus = "draft" | "submitted" | "in_progress" | "review" | "done";

/** 与 PC 看板一致的状态折叠 Tab：待处理（草稿+已提交）/ 进行中 / 待审核 / 已完成。 */
const STATUS_TABS: Array<{ id: string; labelKey: string; statuses: TaskStatus[] }> = [
  { id: "pending", labelKey: "待处理", statuses: ["draft", "submitted"] },
  { id: "in_progress", labelKey: "进行中", statuses: ["in_progress"] },
  { id: "review", labelKey: "待审核", statuses: ["review"] },
  { id: "done", labelKey: "已完成", statuses: ["done"] },
];

/** 选中的逻辑项目 key 本地持久化 key：下次进入项目页默认选中上次的项目。 */
const ACTIVE_PROJECT_KEY_STORAGE = "flowlet.mobile.projects.activeKey";

export function MobileTasksPage() {
  const { language, t } = useAppPreferences();
  // 项目页展示全部设备的项目快照，头部在逻辑项目间切换，每个项目内混合多设备任务。
  const projects = useMobileProjects(null);
  const refreshController = useMobileRefreshController();
  const [statusTab, setStatusTab] = useState(STATUS_TABS[0].id);
  // 从本地存储恢复上次选中的项目；列表加载完成后找不到对应项目时回退到第一个。
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(ACTIVE_PROJECT_KEY_STORAGE);
    } catch {
      return null;
    }
  });
  const [selected, setSelected] = useState<{ task: SyncedProjectTask; project: SharedDeviceProject } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitialTarget, setComposeInitialTarget] = useState("");

  // 跨设备逻辑项目（同名/同 workspaceProjectId 合并），按最近更新倒序，默认选中第一个。
  const projectGroups = useMemo(() => groupMobileProjects(projects.data ?? []), [projects.data]);
  const activeProject = useMemo(
    () => projectGroups.find((group) => group.key === activeProjectKey) ?? projectGroups[0] ?? null,
    [activeProjectKey, projectGroups],
  );

  const changeActiveProjectKey = (key: string) => {
    setActiveProjectKey(key);
    try {
      window.localStorage.setItem(ACTIVE_PROJECT_KEY_STORAGE, key);
    } catch {
      // 存储不可用时仅保留会话内选择。
    }
  };

  // 可执行项目（hasLocalBinding）：添加任务时选择「目标设备 + 项目」。
  const executableProjects = useMemo(
    () => (projects.data ?? []).filter((project) => project.hasLocalBinding),
    [projects.data],
  );

  const allTasks = useMemo(() => activeProject?.tasks ?? [], [activeProject]);

  const activeTab = STATUS_TABS.find((tab) => tab.id === statusTab) ?? STATUS_TABS[0];
  const filteredTasks = useMemo(
    () => allTasks.filter((item) => activeTab.statuses.includes(item.task.status as TaskStatus)),
    [activeTab, allTasks],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allTasks) {
      const key = item.task.status as TaskStatus;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [allTasks]);

  const openSubmit = () => {
    // 优先预选当前项目的可执行设备；当前项目不可执行时取第一个可执行项目。
    const candidates = activeProject
      ? executableProjects.filter((project) => project.projectId === activeProject.projectId)
      : [];
    const fallback = candidates[0] ?? executableProjects[0] ?? null;
    setComposeInitialTarget(fallback ? `${fallback.deviceId}@${fallback.projectId}` : "");
    setComposeOpen(true);
  };

  const handleStatusChanged = (taskId: string, status: string) => {
    // 状态迁移后同步本地卡片展示：先切到对应 Tab，再按最新状态刷新选中项。
    const nextTab = STATUS_TABS.find((tab) => tab.statuses.includes(status as TaskStatus));
    if (nextTab) setStatusTab(nextTab.id);
    setSelected((current) => (current && current.task.id === taskId ? { ...current, task: { ...current.task, status } } : current));
  };

  return (
    <>
      <MobilePullToRefresh
        disabled={refreshController.disabled}
        refreshing={refreshController.loading}
        onRefresh={refreshController.refresh}
      >
      <section className={styles.page}>
        <header className={`${styles.heading} ${styles.headingWithPicker}`}>
          <div className={styles.headingTitleRow}>
            <h2>
              <MobileProjectTitlePicker
                groups={projectGroups}
                selectedKey={activeProject?.key ?? null}
                onChange={changeActiveProjectKey}
                formatTitle={(name) => t("项目 · {project}", { project: name ?? "…" })}
              />
            </h2>
            <MobileLastRefreshTime value={refreshController.lastSuccessAt} />
          </div>
          <p>{t("查看所有设备上单个项目的任务，并提交新任务到指定设备")}</p>
        </header>

        {projects.isLoading ? (
          <div className={`${styles.card} ${styles.state}`}><span>{t("正在加载项目…")}</span></div>
        ) : null}
        {projects.isError ? (
          <div className={`${styles.card} ${styles.state}`}>
            <strong>{t("项目加载失败")}</strong>
            <span>{projects.error.message}</span>
          </div>
        ) : null}
        {!projects.isLoading && !projects.isError && (projects.data?.length ?? 0) === 0 ? (
          <div className={`${styles.card} ${styles.state}`}>
            <strong>{t("暂无项目")}</strong>
            <span>{t("尚未同步任何项目，或项目同步尚未完成。")}</span>
          </div>
        ) : null}

        {!projects.isLoading && !projects.isError && (projects.data?.length ?? 0) > 0 ? (
          <>
            <div className={styles.taskTabs} role="group" aria-label={t("任务状态")}>
              {STATUS_TABS.map((tab) => {
                const count = tab.statuses.reduce((total, status) => total + (statusCounts[status] ?? 0), 0);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={statusTab === tab.id}
                    onClick={() => setStatusTab(tab.id)}
                  >
                    {t(tab.labelKey)}
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>

            {filteredTasks.length === 0 ? (
              <div className={`${styles.card} ${styles.state}`}>
                <strong>{t("暂无任务")}</strong>
                <span>{t("当前状态下没有任务，点击右下角「添加任务」创建。")}</span>
              </div>
            ) : (
              <div className={styles.taskList}>
                {filteredTasks.map(({ task, project }) => (
                  <TaskCard
                    key={`${project.deviceId}-${project.projectId}-${task.id}`}
                    task={task}
                    project={project}
                    language={language}
                    t={t}
                    onOpen={() => setSelected({ task, project })}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}

        <MobileTaskDetailSheet
          task={selected?.task ?? null}
          project={selected?.project ?? null}
          deviceId={selected?.project?.deviceId ?? null}
          onClose={() => setSelected(null)}
          onStatusChanged={handleStatusChanged}
        />
      </section>
      </MobilePullToRefresh>

      {/* FAB 放在下拉刷新容器外：下拉刷新时内容区带 transform，fixed 元素会相对 transform
          祖先定位导致位移。原生 button 完全掌控样式，避免 Semi Button 全局样式覆盖变形。 */}
      {executableProjects.length > 0 ? (
        <button
          type="button"
          className={styles.addTaskFab}
          aria-label={t("添加任务")}
          onClick={openSubmit}
        >
          <IconPlus />
        </button>
      ) : null}

      <MobileTaskComposeSheet
        visible={composeOpen}
        executableProjects={executableProjects}
        initialTarget={composeInitialTarget}
        onClose={() => setComposeOpen(false)}
        onSubmitted={() => setStatusTab("pending")}
      />
    </>
  );
}

function TaskCard({
  task,
  project,
  language,
  t,
  onOpen,
}: {
  task: SyncedProjectTask;
  project: SharedDeviceProject;
  language: TimestampLanguage;
  t: (source: string, variables?: Record<string, string | number>) => string;
  onOpen: () => void;
}) {
  return (
    <article
      className={styles.taskCard}
      role="button"
      tabIndex={0}
      aria-label={`${task.title}，${t("任务详情")}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.taskTopline}>
        <span className={styles.taskProject}>{project.projectName}</span>
        <TaskStatusTag status={task.status} t={t} />
      </div>
      <strong className={styles.taskTitle}>{task.title}</strong>
      <div className={styles.taskMeta}>
        <span className={styles.roundBadge}>{t("第 {n} 轮", { n: executionRoundFromCount(task.executionCount ?? 0, task.status as ProjectTaskStatus) })}</span>
        <span>{project.deviceDisplayName}</span>
        <time>{t("更新于 {time}", { time: formatFullTimestamp(task.updatedAt, language) })}</time>
      </div>
    </article>
  );
}

function TaskStatusTag({ status, t }: { status: string; t: (source: string) => string }) {
  const label = taskStatusLabel(status as TaskStatus, t);
  const tone = taskStatusTone(status as TaskStatus);
  return <Tag color={tone} size="small">{label}</Tag>;
}

function taskStatusLabel(status: TaskStatus, t: (source: string) => string) {
  switch (status) {
    case "draft": return t("草稿");
    case "submitted": return t("已提交");
    case "in_progress": return t("执行中");
    case "review": return t("待审核");
    case "done": return t("已完成");
    default: return status;
  }
}

function taskStatusTone(status: TaskStatus) {
  switch (status) {
    case "submitted": return "blue";
    case "in_progress": return "green";
    case "review": return "orange";
    case "done": return "light-blue";
    default: return "grey";
  }
}
