import { Button, Input, Select, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SharedDeviceProject, SyncedProjectTask } from "../domains/device-sync/types";
import { useMobileEditTask, useMobileSubmitTask } from "../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../shared/errors/AppError";
import { APP_OVERLAY_Z_INDEX } from "../shared/ui/overlayLayers";
import styles from "./MobileTaskComposeSheet.module.css";

const CLOSE_ANIMATION_MS = 200;
const EXPAND_GESTURE_PX = 28;
const COLLAPSE_GESTURE_PX = 48;
const CLOSE_GESTURE_PX = 64;

/** 与 PC 看板一致的 Agent Profile 选项（任务执行驱动目标 Agent）。 */
const AGENT_PROFILES = ["Claude Code", "OpenCode", "Pi", "Codex", "DeepSeek Harness"];

/**
 * 添加任务底部弹窗：与任务详情抽屉（MobileTaskDetailSheet）一致的二段展开交互。
 * 任务归属项目由页面级当前选中决定，这里只需选择目标设备（该项目下已绑定本地目录、
 * 可执行任务的设备）。默认半屏展示核心字段（目标设备、任务标题）并提示上滑展开，
 * 上滑/点击把手进入完整表单（任务描述、任务类型、Agent Profile），下滑收回半屏，
 * 半屏状态下再下滑关闭。提交走签名 LAN 通道，任务默认以草稿创建。
 *
 * 传入 `editingTask` 时进入「编辑草稿」模式：设备锁定到任务所在设备、标题预填，
 * 只允许修改标题（设备快照不携带描述等正文，避免移动端误清空），保存走编辑命令。
 */
export function MobileTaskComposeSheet({
  visible,
  projectName,
  executableDevices,
  initialDeviceId,
  editingTask,
  onClose,
  onSubmitted,
  onEdited,
}: {
  visible: boolean;
  /** 页面级当前选中的项目名（任务归属，仅用于展示）。 */
  projectName: string;
  /** 该项目下可执行目标设备（hasLocalBinding）。 */
  executableDevices: SharedDeviceProject[];
  initialDeviceId: string;
  /** 编辑目标：非空时进入「编辑草稿」模式，设备锁定、标题预填、保存走编辑命令。 */
  editingTask?: { task: SyncedProjectTask; project: SharedDeviceProject } | null;
  onClose: () => void;
  /** 提交成功后由页面切换状态 Tab 等后续动作。 */
  onSubmitted?: () => void;
  /** 编辑保存成功后由页面刷新选中任务的本地展示。 */
  onEdited?: () => void;
}) {
  const { t } = useAppPreferences();
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<"code" | "readonly">("code");
  const [agentProfile, setAgentProfile] = useState("Claude Code");
  const closeTimer = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; allowDownGesture: boolean } | null>(null);

  const editing = editingTask != null;
  const draftDevice = executableDevices.find((device) => device.deviceId === deviceId) ?? null;
  // 提交目标设备由表单选中的设备决定，任务归属项目为页面级当前选中项目。
  // 编辑模式固定使用任务所在设备，新增模式使用表单选中的设备。
  const submit = useMobileSubmitTask(editing ? null : (draftDevice?.deviceId ?? null));
  const edit = useMobileEditTask(editing ? deviceId : null);
  const canSubmit = deviceId.length > 0 && title.trim().length > 0 && !(editing ? edit.isPending : submit.isPending);

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

  // 重新打开时复位退出动画、展开状态与表单；编辑模式预填任务标题并锁定设备。
  useEffect(() => {
    if (!visible) return;
    setClosing(false);
    setExpanded(false);
    setDeviceId(editingTask?.project.deviceId ?? initialDeviceId);
    setTitle(editingTask?.task.title ?? "");
    setDescription("");
    setTaskType("code");
    setAgentProfile("Claude Code");
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, [visible, initialDeviceId, editingTask]);

  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  useEffect(() => {
    if (!visible || import.meta.env.TAURI_ENV_PLATFORM !== "android") return;
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
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [visible]);

  if (!visible) return null;

  const doSubmit = async () => {
    if (!canSubmit) return;
    try {
      if (editing) {
        await edit.mutateAsync({ taskId: editingTask.task.id, title: title.trim() });
        Toast.success(t("任务内容已更新"));
        onClose();
        onEdited?.();
      } else {
        if (!draftDevice) return;
        await submit.mutateAsync({
          projectId: draftDevice.projectId,
          title: title.trim(),
          description: description.trim(),
          taskType,
          agentProfile,
        });
        Toast.success(t("任务已创建为草稿"));
        onClose();
        onSubmitted?.();
      }
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
        aria-label={editing ? t("编辑任务") : t("添加任务")}
        data-closing={closing || undefined}
        data-expanded={expanded || undefined}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          const targetEl = event.target as Element;
          const isHandle = targetEl.closest(`.${styles.handle}`) != null;
          const isInteractive = targetEl.closest("button, a, input, textarea, select") != null;
          if (!touch || (isInteractive && !isHandle)) {
            gesture.current = null;
            return;
          }
          const fromFixedHeader = isHandle || targetEl.closest(`.${styles.header}`) != null;
          // 半屏时 body 锁定（touchAction: none），上滑触发展开；展开后 body 滚动，
          // 仅当内容已滚到顶部时才允许下滑收回半屏，避免与内容滚动冲突。
          const fromBodyTop = targetEl.closest(`.${styles.body}`) != null
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
          if (editing) {
            // 编辑模式固定半屏，不展开完整表单，只允许下滑关闭。
            if (!expanded && start.allowDownGesture && deltaY >= CLOSE_GESTURE_PX) {
              gesture.current = null;
              requestClose();
            }
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
        {!editing ? (
          <button
            type="button"
            className={styles.handle}
            aria-label={expanded ? t("收起添加任务表单") : t("展开添加任务表单")}
            onClick={() => setExpanded((value) => !value)}
          >
            <span />
          </button>
        ) : null}
        <header className={styles.header}>
          <div className={styles.headerTopline}>
            <strong className={styles.title}>{editing ? t("编辑任务") : (projectName ? t("添加任务到「{name}」", { name: projectName }) : t("添加任务"))}</strong>
          </div>
          <div className={styles.meta}>
            <span>{editing
              ? `${projectName} · ${editingTask!.project.deviceDisplayName}`
              : draftDevice ? `${projectName} · ${draftDevice.deviceDisplayName}` : t("选择目标设备")}</span>
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
            <div className={styles.form}>
              <label>{t("目标设备")}
                <Select
                  value={deviceId}
                  disabled={editing}
                  optionList={editing
                    ? [{ value: editingTask!.project.deviceId, label: editingTask!.project.deviceDisplayName }]
                    : executableDevices.map((device) => ({ value: device.deviceId, label: device.deviceDisplayName }))}
                  zIndex={APP_OVERLAY_Z_INDEX.modal + 1}
                  onChange={(value) => setDeviceId(String(value))}
                />
              </label>
              <label>{t("任务标题")}<Input value={title} placeholder={t("例如：修复登录页样式")} onChange={(value) => setTitle(value)} /></label>
              {expanded && !editing ? (
                <>
                  <label>{t("任务描述")}<TextArea value={description} placeholder={t("补充上下文与期望结果（可选）")} autosize onChange={(value) => setDescription(value)} /></label>
                  <div className={styles.formGrid}>
                    <label>{t("任务类型")}<Select value={taskType} optionList={[{ value: "code", label: t("代码修改") }, { value: "readonly", label: t("只读分析") }]} zIndex={APP_OVERLAY_Z_INDEX.modal + 1} onChange={(value) => setTaskType(String(value) as "code" | "readonly")} /></label>
                    <label>{t("Agent Profile")}<Select value={agentProfile} optionList={AGENT_PROFILES.map((profile) => ({ value: profile, label: profile }))} zIndex={APP_OVERLAY_Z_INDEX.modal + 1} onChange={(value) => setAgentProfile(String(value))} /></label>
                  </div>
                  <div className={styles.permissions}>
                    <strong>{t("执行说明")}</strong>
                    <span>{t("任务会先以草稿状态创建，在任务详情中通过局域网直连提交后，由目标设备上的 Flowlet 调度执行。")}</span>
                  </div>
                </>
              ) : null}
            </div>
            {!expanded && !editing ? <div className={styles.expandHint}>{t("上滑展开完整表单")}</div> : null}
          </div>
        </div>
        <footer className={styles.footer}>
          <div className={styles.footerActions}>
            <Button onClick={requestClose}>{t("取消")}</Button>
            <Button theme="solid" type="primary" disabled={!canSubmit} loading={editing ? edit.isPending : submit.isPending} onClick={() => void doSubmit()}>
              {editing ? t("保存") : t("添加任务")}
            </Button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
