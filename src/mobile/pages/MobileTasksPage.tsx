import { IconPlus } from "@douyinfe/semi-icons";
import { Button, Input, Select, SideSheet, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { SharedDeviceProject } from "../../domains/device-sync/types";
import { useMobileProjects, useMobileSubmitTask } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp, type TimestampLanguage } from "../../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { MobileDeviceTitlePicker, useMobileDevicePickerState } from "../MobileDevicePicker";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobilePullToRefresh } from "../MobilePullToRefresh";
import styles from "./MobilePage.module.css";

type TaskStatus = "draft" | "submitted" | "in_progress" | "review" | "done";

export function MobileTasksPage() {
  const { language, t } = useAppPreferences();
  const picker = useMobileDevicePickerState({ allowAll: false });
  const deviceId = picker.effectiveDeviceId;
  const projects = useMobileProjects(deviceId);
  const submit = useMobileSubmitTask(deviceId);
  const refreshController = useMobileRefreshController(deviceId);
  const [draftProject, setDraftProject] = useState<SharedDeviceProject | null>(null);
  const [form, setForm] = useState({ title: "", description: "", taskType: "code", priority: "p2" });

  const executableProjects = useMemo(
    () => (projects.data ?? []).filter((project) => project.hasLocalBinding),
    [projects.data],
  );

  const openSubmit = (project: SharedDeviceProject) => {
    setDraftProject(project);
    setForm({ title: "", description: "", taskType: "code", priority: "p2" });
  };

  const canSubmit = form.title.trim().length > 0 && !submit.isPending;

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
      Toast.success(t("任务已提交到 {device}", { device: draftProject.deviceDisplayName }));
      setDraftProject(null);
    } catch (error) {
      Toast.error(t("提交失败：{message}", { message: errorMessage(error) }));
    }
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

      <div className={styles.deviceList}>
        {(projects.data ?? []).map((project) => (
          <ProjectCard
            key={`${project.deviceId}-${project.projectId}`}
            project={project}
            executable={project.hasLocalBinding}
            onOpenSubmit={() => openSubmit(project)}
            language={language}
            t={t}
          />
        ))}
      </div>

      <SideSheet
        title={draftProject ? t("提交任务到「{name}」", { name: draftProject.projectName }) : t("提交任务")}
        visible={draftProject != null}
        placement="right"
        width="100%"
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setDraftProject(null)}
        headerStyle={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
        bodyStyle={{ padding: "16px 16px calc(env(safe-area-inset-bottom, 0px) + 92px)" }}
        footer={(
          <div className={styles.importFooter}>
            <Button onClick={() => setDraftProject(null)}>{t("取消")}</Button>
            <Button theme="solid" type="primary" disabled={!canSubmit} loading={submit.isPending} onClick={() => void doSubmit()}>
              {t("提交任务")}
            </Button>
          </div>
        )}
      >
        <div className={styles.form}>
          <label>{t("任务标题")}<Input value={form.title} placeholder={t("例如：修复登录页样式")} onChange={(title) => setForm((f) => ({ ...f, title }))} /></label>
          <label>{t("任务描述")}<TextArea value={form.description} placeholder={t("补充上下文与期望结果（可选）")} autosize onChange={(description) => setForm((f) => ({ ...f, description }))} /></label>
          <div className={styles.formGrid}>
            <label>{t("任务类型")}<Select value={form.taskType} optionList={[{ value: "code", label: t("代码修改") }, { value: "readonly", label: t("只读分析") }]} onChange={(taskType) => setForm((f) => ({ ...f, taskType: String(taskType) }))} /></label>
            <label>{t("优先级")}<Select value={form.priority} optionList={[{ value: "p0", label: "P0" }, { value: "p1", label: "P1" }, { value: "p2", label: "P2" }]} onChange={(priority) => setForm((f) => ({ ...f, priority: String(priority) }))} /></label>
          </div>
          <div className={styles.permissions}>
            <strong>{t("执行说明")}</strong>
            <span>{t("任务会直接进入已提交状态排队，由目标设备上的 Flowlet 调度执行；完成后可在设备项目目录中查看状态。")}</span>
          </div>
        </div>
      </SideSheet>
    </section>
    </MobilePullToRefresh>
  );
}

function ProjectCard({
  project,
  executable,
  onOpenSubmit,
  language,
  t,
}: {
  project: SharedDeviceProject;
  executable: boolean;
  onOpenSubmit: () => void;
  language: TimestampLanguage;
  t: (source: string, variables?: Record<string, string | number>) => string;
}) {
  return (
    <article className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <strong>{project.projectName}</strong>
          <span>{project.deviceDisplayName} · {t("更新于 {time}", { time: formatFullTimestamp(lastUpdated(project), language) })}</span>
        </div>
        <span className={styles.status} data-state={executable ? "success" : "muted"}>
          <i />{executable ? t("可执行") : t("未绑定目录")}
        </span>
      </div>
      {project.tasks.length === 0 ? (
        <div className={styles.deviceDetailsState}>{t("暂无任务")}</div>
      ) : (
        <div className={styles.deviceDetails} style={{ paddingTop: 4 }}>
          {project.tasks.slice(0, 5).map((task) => (
            <div key={task.id} className={styles.installedAgent}>
              <div className={styles.installedAgentMain}>
                <strong>{task.title}</strong>
                <span>{formatFullTimestamp(task.updatedAt, language)}</span>
              </div>
              <TaskStatusTag status={task.status} t={t} />
            </div>
          ))}
        </div>
      )}
      {executable ? (
        <div className={styles.actions} style={{ marginTop: 12 }}>
          <Button theme="solid" type="primary" icon={<IconPlus />} onClick={onOpenSubmit}>{t("提交任务")}</Button>
        </div>
      ) : null}
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

function lastUpdated(project: SharedDeviceProject): string {
  const times = project.tasks.map((task) => task.updatedAt);
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : project.updatedAt;
}
