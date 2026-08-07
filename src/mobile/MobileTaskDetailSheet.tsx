import { IconClose, IconCopy } from "@douyinfe/semi-icons";
import { Button, Toast } from "@douyinfe/semi-ui-19";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SharedDeviceProject, SyncedProjectTask } from "../domains/device-sync/types";
import { executionRoundFromCount, type ProjectTaskStatus } from "../domains/project/types";
import { useMobileSetTaskStatus } from "../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../shared/errors/AppError";
import { formatFullTimestamp } from "../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../shared/ui/overlayLayers";
import styles from "./MobileTaskDetailSheet.module.css";

type TaskStatus = "draft" | "submitted" | "in_progress" | "review" | "done";

const CLOSE_ANIMATION_MS = 200;
const EXPAND_GESTURE_PX = 28;
const COLLAPSE_GESTURE_PX = 48;
const CLOSE_GESTURE_PX = 64;

/**
 * 任务详情底部弹窗：展示任务完整信息，并支持「提交 / 撤回」状态迁移。
 * 状态迁移与 PC 看板一致（草稿 ↔ 已提交），仅通过局域网直连变更。
 * 交互与移动端会话详情抽屉（MobileSessionSheet）对齐：
 * 默认半屏展示核心状态，上滑/点击把手进入完整视图，下滑收回半屏，半屏状态下再下滑关闭。
 */
export function MobileTaskDetailSheet({
  task,
  project,
  deviceId,
  onClose,
  onStatusChanged,
}: {
  task: SyncedProjectTask | null;
  project: SharedDeviceProject | null;
  deviceId: string | null;
  onClose: () => void;
  onStatusChanged?: (taskId: string, status: string) => void;
}) {
  const { language, t } = useAppPreferences();
  const setStatus = useMobileSetTaskStatus(deviceId);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; allowDownGesture: boolean } | null>(null);

  const requestClose = () => {
    setClosing((wasClosing) => {
      if (!wasClosing) {
        closeTimer.current = window.setTimeout(onClose, CLOSE_ANIMATION_MS);
      }
      return true;
    });
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // 切换任务或重新打开时复位退出动画与展开状态，并聚焦关闭按钮。
  useEffect(() => {
    setClosing(false);
    setExpanded(false);
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (task) closeButtonRef.current?.focus({ preventScroll: true });
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!task) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [task]);

  useEffect(() => {
    if (!task || import.meta.env.TAURI_ENV_PLATFORM !== "android") return;
    let disposed = false;
    let listener: Awaited<ReturnType<typeof onBackButtonPress>> | null = null;
    void onBackButtonPress(() => requestCloseRef.current())
      .then((registeredListener) => {
        if (disposed) {
          void registeredListener.unregister().catch(() => undefined);
          return;
        }
        listener = registeredListener;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      void listener?.unregister().catch(() => undefined);
    };
  }, [task]);

  useEffect(() => {
    if (!task) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [task]);

  if (!task || !project) return null;

  const canMutate = task.status === "draft" || task.status === "submitted";

  const mutate = async (status: "draft" | "submitted") => {
    try {
      const result = await setStatus.mutateAsync({ taskId: task.id, status });
      if (status === "submitted") {
        Toast.success(t("任务已提交到 {device}", { device: project.deviceDisplayName }));
      } else {
        Toast.success(t("任务已撤回为草稿"));
      }
      onStatusChanged?.(result.taskId, result.status);
    } catch (error) {
      Toast.error(t("操作失败：{message}", { message: errorMessage(error) }));
    }
  };

  return createPortal(
    <div
      className={styles.backdrop}
      data-closing={closing || undefined}
      style={{ zIndex: APP_OVERLAY_Z_INDEX.modal }}
      onClick={requestClose}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title}，${t("任务详情")}`}
        data-closing={closing || undefined}
        data-expanded={expanded || undefined}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          const target = event.target as Element;
          const isHandle = target.closest(`.${styles.handle}`) != null;
          const isInteractive = target.closest("button, a, input, textarea, select") != null;
          if (!touch || (isInteractive && !isHandle)) {
            gesture.current = null;
            return;
          }
          const fromFixedHeader = isHandle || target.closest(`.${styles.header}`) != null;
          const fromBodyTop = target.closest(`.${styles.body}`) != null
            && (bodyRef.current?.scrollTop ?? 0) <= 1;
          gesture.current = {
            x: touch.clientX,
            y: touch.clientY,
            allowDownGesture: fromFixedHeader || fromBodyTop,
          };
        }}
        onTouchMove={(event) => {
          const start = gesture.current;
          const touch = event.touches[0];
          if (!start || !touch) return;
          const deltaX = touch.clientX - start.x;
          const deltaY = touch.clientY - start.y;
          if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
            gesture.current = null;
            return;
          }
          if (!expanded && deltaY <= -EXPAND_GESTURE_PX) {
            gesture.current = null;
            setExpanded(true);
          } else if (expanded && start.allowDownGesture && deltaY >= COLLAPSE_GESTURE_PX) {
            gesture.current = null;
            setExpanded(false);
          } else if (!expanded && start.allowDownGesture && deltaY >= CLOSE_GESTURE_PX) {
            gesture.current = null;
            requestClose();
          }
        }}
        onTouchEnd={() => { gesture.current = null; }}
        onTouchCancel={() => { gesture.current = null; }}
      >
        <button
          type="button"
          className={styles.handle}
          aria-label={expanded ? t("收起任务详情") : t("展开任务详情")}
          onClick={() => setExpanded((value) => !value)}
        >
          <span />
        </button>
        <header className={styles.header}>
          <div className={styles.headerTopline}>
            <span className={styles.state} data-state={task.status}>
              <i />
              {taskStatusLabel(task.status as TaskStatus, t)}
            </span>
            <strong className={styles.title} title={task.title}>{task.title}</strong>
            <button type="button" ref={closeButtonRef} className={styles.closeButton} aria-label={t("关闭")} onClick={requestClose}>
              <IconClose />
            </button>
          </div>
          <div className={styles.meta}>
            <span>{project.projectName}</span>
            <span>{project.deviceDisplayName}</span>
            <span>{t("更新于 {time}", { time: formatFullTimestamp(task.updatedAt, language) })}</span>
          </div>
        </header>
        <div className={styles.bodyFrame}>
          <div
            ref={bodyRef}
            className={styles.body}
            style={{
              overflowY: expanded ? "auto" : "hidden",
              touchAction: expanded ? "pan-y" : "none",
            }}
          >
            <div className={styles.stats}>
              <div className={styles.stat}><span>{t("任务状态")}</span><strong>{taskStatusLabel(task.status as TaskStatus, t)}</strong></div>
              <div className={styles.stat}><span>{t("执行轮次")}</span><strong>{t("第 {n} 轮", { n: executionRoundFromCount(task.executionCount ?? 0, task.status as ProjectTaskStatus) })}</strong></div>
              <div className={styles.stat}><span>{t("所属项目")}</span><strong className={styles.ellipsis}>{project.projectName}</strong></div>
            </div>
            <section className={styles.section}>
              <strong className={styles.sectionTitle}>{t("任务信息")}</strong>
              <div className={styles.infoList}>
                <InfoItem label={t("任务 ID")} value={task.id} copyable t={t} />
                <InfoItem label={t("所属项目")} value={project.projectName} t={t} />
                <InfoItem label={t("设备")} value={project.deviceDisplayName} t={t} />
                <InfoItem label={t("执行轮次")} value={t("第 {n} 轮", { n: executionRoundFromCount(task.executionCount ?? 0, task.status as ProjectTaskStatus) })} t={t} />
                <InfoItem label={t("更新时间")} value={formatFullTimestamp(task.updatedAt, language)} t={t} />
              </div>
            </section>
            <div className={styles.hint}>{taskStatusHint(task.status as TaskStatus, t)}</div>
          </div>
        </div>
        {canMutate ? (
          <footer className={styles.footer}>
            <span className={styles.lanHint}>{t("局域网直连")} · {t("状态变更仅允许通过局域网直连操作")}</span>
            {task.status === "draft" ? (
              <Button
                type="primary"
                theme="solid"
                block
                loading={setStatus.isPending}
                disabled={setStatus.isPending}
                onClick={() => void mutate("submitted")}
              >
                {t("提交")}
              </Button>
            ) : (
              <Button
                type="primary"
                theme="borderless"
                block
                loading={setStatus.isPending}
                disabled={setStatus.isPending}
                onClick={() => void mutate("draft")}
              >
                {t("撤回")}
              </Button>
            )}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function InfoItem({ label, value, copyable, t }: {
  label: string;
  value: string;
  copyable?: boolean;
  t: (key: string) => string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("已复制"));
    } catch {
      Toast.error(t("复制失败"));
    }
  };
  return (
    <div className={styles.infoItem}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      {copyable ? (
        <button type="button" className={styles.copyButton} aria-label={t("复制")} onClick={() => void copy()}>
          <IconCopy />
        </button>
      ) : null}
    </div>
  );
}

function taskStatusLabel(status: TaskStatus, t: (key: string) => string) {
  switch (status) {
    case "draft": return t("草稿");
    case "submitted": return t("已提交");
    case "in_progress": return t("执行中");
    case "review": return t("待审核");
    case "done": return t("已完成");
    default: return status;
  }
}

function taskStatusHint(status: TaskStatus, t: (key: string) => string) {
  switch (status) {
    case "draft": return t("任务等待提交到桌面端");
    case "submitted": return t("任务已提交，等待桌面端调度执行");
    case "in_progress": return t("任务执行中，由桌面端调度执行");
    case "review": return t("任务等待桌面端审核");
    case "done": return t("任务已完成");
    default: return "";
  }
}
