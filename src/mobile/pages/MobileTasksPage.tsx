import { IconPlus } from "@douyinfe/semi-icons";
import { Button, Input, Select, SideSheet, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedDeviceProject, SyncedProjectTask } from "../../domains/device-sync/types";
import { useMobileProjects, useMobileSubmitTask } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp, type TimestampLanguage } from "../../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { MobileDeviceTitlePicker, useMobileDevicePickerState } from "../MobileDevicePicker";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
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

export function MobileTasksPage() {
  const { language, t } = useAppPreferences();
  const picker = useMobileDevicePickerState({ allowAll: false });
  const deviceId = picker.effectiveDeviceId;
  const projects = useMobileProjects(deviceId);
  const submit = useMobileSubmitTask(deviceId);
  const refreshController = useMobileRefreshController(deviceId);
  const [statusTab, setStatusTab] = useState(STATUS_TABS[0].id);
  const [selected, setSelected] = useState<{ task: SyncedProjectTask; project: SharedDeviceProject } | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [form, setForm] = useState({ projectId: "", title: "", description: "", taskType: "code", priority: "p2" });

  const executableProjects = useMemo(
    () => (projects.data ?? []).filter((project) => project.hasLocalBinding),
    [projects.data],
  );

  // 跨项目聚合任务，统一按最近更新时间倒序。
  const allTasks = useMemo(() => {
    const items: Array<{ task: SyncedProjectTask; project: SharedDeviceProject }> = [];
    for (const project of projects.data ?? []) {
      for (const task of project.tasks) {
        items.push({ task, project });
      }
    }
    return items.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  }, [projects.data]);

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

  const draftProject = executableProjects.find((project) => project.projectId === form.projectId) ?? null;
  const canSubmit = form.projectId.length > 0 && form.title.trim().length > 0 && !submit.isPending;

  const openSubmit = () => {
    setForm((f) => ({ ...f, projectId: executableProjects[0]?.projectId ?? "" }));
    setSubmitOpen(true);
  };

  const doSubmit = async () => {
    if (!draftProject || !canSubmit) return;
    try {
      await submit.mutateAsync({
        projectId: draftProject.projectId,
        title: form.title.trim(),
        description: form.description.trim(),
        taskType: form.taskType as "code" | "readonly",
        priority: form.priority as "p0" | "p1" | "p2",
      });
      Toast.success(t("任务已创建为草稿"));
      setSubmitOpen(false);
      setStatusTab("pending");
    } catch (error) {
      Toast.error(t("操作失败：{message}", { message: errorMessage(error) }));
    }
  };

  const handleStatusChanged = (taskId: string, status: string) => {
    // 状态迁移后同步本地卡片展示：先切到对应 Tab，再按最新状态刷新选中项。
    const nextTab = STATUS_TABS.find((tab) => tab.statuses.includes(status as TaskStatus));
    if (nextTab) setStatusTab(nextTab.id);
    setSelected((current) => (current && current.task.id === taskId ? { ...current, task: { ...current.task, status } } : current));
  };

  return (
    <MobilePullToRefresh
      disabled={refreshController.disabled}
      refreshing={refreshController.loading}
      onRefresh={refreshController.refresh}
    >
    <section className={styles.page}>
      <header className={`${styles.heading} ${styles.headingWithPicker}`}>
        <div className={styles.headingTitleRow}>
          <MobileDeviceTitlePicker
            state={picker}
            formatTitle={(name) => t("项目 · {device}", { device: name ?? "…" })}
          />
          <MobileLastRefreshTime value={refreshController.lastSuccessAt} />
        </div>
        <p>{t("把任务提交到指定设备的项目，由该设备上的 Flowlet 调度执行")}</p>
      </header>

      {executableProjects.length > 0 ? (
        <div className={styles.taskSubmitBar}>
          <Button theme="solid" type="primary" icon={<IconPlus />} onClick={openSubmit}>
            {t("提交任务")}
          </Button>
        </div>
      ) : null}

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
          <span>{t("该设备尚未同步任何项目，或项目同步尚未完成。")}</span>
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
              <span>{t("当前状态下没有任务，点击「提交任务」创建。")}</span>
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

      <SideSheet
        title={draftProject ? t("提交任务到「{name}」", { name: draftProject.projectName }) : t("提交任务")}
        visible={submitOpen}
        placement="right"
        width="100%"
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setSubmitOpen(false)}
        headerStyle={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
        bodyStyle={{ padding: "16px 16px calc(env(safe-area-inset-bottom, 0px) + 92px)" }}
        footer={(
          <div className={styles.importFooter}>
            <Button onClick={() => setSubmitOpen(false)}>{t("取消")}</Button>
            <Button theme="solid" type="primary" disabled={!canSubmit} loading={submit.isPending} onClick={() => void doSubmit()}>
              {t("提交任务")}
            </Button>
          </div>
        )}
      >
        <div className={styles.form}>
          {executableProjects.length > 1 ? (
            <label>{t("项目")}
              <Select
                value={form.projectId}
                optionList={executableProjects.map((project) => ({ value: project.projectId, label: project.projectName }))}
                onChange={(projectId) => setForm((f) => ({ ...f, projectId: String(projectId) }))}
              />
            </label>
          ) : null}
          <label>{t("任务标题")}<Input value={form.title} placeholder={t("例如：修复登录页样式")} onChange={(title) => setForm((f) => ({ ...f, title }))} /></label>
          <label>{t("任务描述")}<TextArea value={form.description} placeholder={t("补充上下文与期望结果（可选）")} autosize onChange={(description) => setForm((f) => ({ ...f, description }))} /></label>
          <div className={styles.formGrid}>
            <label>{t("任务类型")}<Select value={form.taskType} optionList={[{ value: "code", label: t("代码修改") }, { value: "readonly", label: t("只读分析") }]} onChange={(taskType) => setForm((f) => ({ ...f, taskType: String(taskType) }))} /></label>
            <label>{t("优先级")}<Select value={form.priority} optionList={[{ value: "p0", label: "P0" }, { value: "p1", label: "P1" }, { value: "p2", label: "P2" }]} onChange={(priority) => setForm((f) => ({ ...f, priority: String(priority) }))} /></label>
          </div>
          <div className={styles.permissions}>
            <strong>{t("执行说明")}</strong>
            <span>{t("任务会先以草稿状态创建，在任务详情中通过局域网直连提交后，由目标设备上的 Flowlet 调度执行。")}</span>
          </div>
        </div>
      </SideSheet>

      <MobileTaskDetailSheet
        task={selected?.task ?? null}
        project={selected?.project ?? null}
        deviceId={deviceId}
        onClose={() => setSelected(null)}
        onStatusChanged={handleStatusChanged}
      />
    </section>
    </MobilePullToRefresh>
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
        {task.priority ? <span className={styles.priorityBadge}>{task.priority.toUpperCase()}</span> : null}
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