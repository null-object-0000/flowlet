import { IconChevronDown, IconClose, IconRefresh } from "@douyinfe/semi-icons";
import { Button, Toast } from "@douyinfe/semi-ui-19";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SharedAgentSession, SyncedAgentInteractionEvent } from "../domains/device-sync/types";
import {
  useMobileRemotePermissions,
  useMobileSessionLanRefresh,
  useReplyMobileRemotePermission,
} from "../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../shared/errors/AppError";
import { formatFullTimestamp } from "../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../shared/formatters/number";
import { APP_OVERLAY_Z_INDEX } from "../shared/ui/overlayLayers";
import { MobileLastRefreshTime } from "./MobileLastRefreshTime";
import { MobileSessionInteraction } from "./MobileSessionInteraction";
import { mobileSessionMetrics } from "./sessionMetrics";
import { followSessionScrollBottom, isSessionScrollNearBottom } from "./sessionScroll";
import styles from "./MobileSessionSheet.module.css";

const CLOSE_ANIMATION_MS = 200;
const EXPAND_GESTURE_PX = 28;
const COLLAPSE_GESTURE_PX = 48;
const CLOSE_GESTURE_PX = 64;
const SESSION_AUTO_REFRESH_MS = 5_000;

/**
 * 会话详情底部弹窗：默认半屏展示核心状态，上滑内容/头部或点击把手进入完整视图。
 * 单会话刷新严格走局域网直连；OpenCode 会话在底部粘性区域直接审批。
 */
export function MobileSessionSheet({
  session,
  onClose,
}: {
  session: SharedAgentSession | null;
  onClose: () => void;
}) {
  const { language, t } = useAppPreferences();
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lastSessionRefreshAt, setLastSessionRefreshAt] = useState<string | null>(null);
  const [sessionAtBottom, setSessionAtBottom] = useState(true);
  const [hasUnseenSessionContent, setHasUnseenSessionContent] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followSessionBottom = useRef(false);
  const previousInteraction = useRef<{ sessionKey: string; version: string } | null>(null);
  const gesture = useRef<{ x: number; y: number; allowDownGesture: boolean } | null>(null);
  const sessionKey = session ? `${session.deviceId}:${session.agentType}:${session.sessionId}` : null;
  const interactionVersion = sessionInteractionVersion(session?.lastInteraction?.events ?? []);
  const activeSessionKey = useRef(sessionKey);
  const autoStartedSessionKey = useRef<string | null>(null);
  const refreshInFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  activeSessionKey.current = sessionKey;
  const { mutateAsync: refreshSessionLan, isPending: sessionRefreshPending } = useMobileSessionLanRefresh(session);

  const refreshSession = useCallback((notify: boolean) => {
    if (!sessionKey) return Promise.resolve();
    if (refreshInFlight.current?.key === sessionKey) return refreshInFlight.current.promise;
    const requestKey = sessionKey;
    const promise = refreshSessionLan()
      .then(() => {
        if (activeSessionKey.current === requestKey) {
          setLastSessionRefreshAt(new Date().toISOString());
        }
        if (notify) Toast.success(t("已通过局域网直连刷新会话"));
      })
      .catch((error) => {
        if (notify) {
          Toast.error(t("直连刷新失败：{message}", { message: errorMessage(error) }));
        }
        throw error;
      })
      .finally(() => {
        if (refreshInFlight.current?.key === requestKey) refreshInFlight.current = null;
      });
    refreshInFlight.current = { key: requestKey, promise };
    return promise;
  }, [refreshSessionLan, sessionKey, t]);

  const requestClose = useCallback(() => {
    setClosing((wasClosing) => {
      if (!wasClosing) {
        closeTimer.current = window.setTimeout(onClose, CLOSE_ANIMATION_MS);
      }
      return true;
    });
  }, [onClose]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const scrollSessionToBottom = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    followSessionScrollBottom(body, true);
    followSessionBottom.current = true;
    setSessionAtBottom(true);
    setHasUnseenSessionContent(false);
  }, []);

  // 会话切换或重新打开时复位退出动画并聚焦关闭按钮。
  useEffect(() => {
    setClosing(false);
    setExpanded(false);
    setLastSessionRefreshAt(null);
    setSessionAtBottom(true);
    setHasUnseenSessionContent(false);
    if (!sessionKey) autoStartedSessionKey.current = null;
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (sessionKey) closeButtonRef.current?.focus({ preventScroll: true });
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey) return;
    const refreshLatest = () => {
      if (document.hidden) return;
      void refreshSession(false).catch(() => undefined);
    };
    if (autoStartedSessionKey.current !== sessionKey) {
      autoStartedSessionKey.current = sessionKey;
      refreshLatest();
    }
    const timer = window.setInterval(refreshLatest, SESSION_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshSession, sessionKey]);

  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!sessionKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionKey, requestClose]);

  useEffect(() => {
    if (!sessionKey || import.meta.env.TAURI_ENV_PLATFORM !== "android") return;
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
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sessionKey]);

  useLayoutEffect(() => {
    if (!sessionKey) {
      previousInteraction.current = null;
      followSessionBottom.current = false;
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const previous = previousInteraction.current;
    if (!previous || previous.sessionKey !== sessionKey) {
      const atBottom = isSessionScrollNearBottom(body);
      followSessionBottom.current = atBottom;
      setSessionAtBottom(atBottom);
      setHasUnseenSessionContent(false);
    } else if (previous.version !== interactionVersion) {
      const wasFollowing = followSessionBottom.current;
      followSessionScrollBottom(body, wasFollowing);
      const atBottom = isSessionScrollNearBottom(body);
      followSessionBottom.current = atBottom;
      setSessionAtBottom(atBottom);
      setHasUnseenSessionContent(!wasFollowing && !atBottom);
    }
    previousInteraction.current = { sessionKey, version: interactionVersion };
  }, [interactionVersion, sessionKey]);

  if (!session) return null;
  const title = session.title?.trim() || t("未命名会话");
  const events = session.lastInteraction?.events ?? [];
  const metrics = mobileSessionMetrics(session);

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
        aria-label={`${title}，${t("会话详情")}`}
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
          ref={closeButtonRef}
          className={styles.handle}
          aria-label={expanded ? t("收起会话详情") : t("展开会话详情")}
          onClick={() => setExpanded((value) => !value)}
        >
          <span />
        </button>
        <header className={styles.header}>
          <div className={styles.headerTopline}>
            <span className={styles.agentBadge}>{agentLabel(session.agentType)}</span>
            <strong className={styles.title} title={title}>{title}</strong>
            <button type="button" className={styles.closeButton} aria-label={t("关闭")} onClick={requestClose}>
              <IconClose />
            </button>
          </div>
          <div className={styles.meta}>
            <span className={styles.state} data-state={session.runtimeStatus}>
              <i />
              {runtimeLabel(session.runtimeStatus, t)}
            </span>
            <span>{session.deviceDisplayName}</span>
            <span>{t("最近活跃：{time}", { time: formatFullTimestamp(session.activityAt, language) })}</span>
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
            onScroll={(event) => {
              const atBottom = isSessionScrollNearBottom(event.currentTarget);
              followSessionBottom.current = atBottom;
              setSessionAtBottom(atBottom);
              if (atBottom) setHasUnseenSessionContent(false);
            }}
          >
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span>Tokens</span>
              <strong>{metrics.truncated ? "≥" : ""}{metrics.tokens == null ? "—" : formatCompactNumber(metrics.tokens, language)}</strong>
            </div>
            <div className={styles.stat}>
              <span>{metrics.source === "agent-native" ? t("原生轮次") : t("请求数")}</span>
              <strong>{metrics.count == null ? "—" : formatInteger(metrics.count, language)}</strong>
            </div>
            <div className={styles.stat} data-error={metrics.failures != null && metrics.failures > 0 || undefined}>
              <span>{metrics.source === "agent-native" ? t("来源") : t("失败")}</span>
              <strong>{metrics.source === "agent-native" ? t("Agent 原生") : formatInteger(metrics.failures ?? 0, language)}</strong>
            </div>
          </div>
          <div className={styles.sectionHeading}>
            <h3 className={styles.sectionLabel}>{t("最近一轮")}</h3>
            <div className={styles.sectionActions}>
              <MobileLastRefreshTime value={lastSessionRefreshAt} />
              <Button
                size="small"
                theme="borderless"
                icon={<IconRefresh />}
                loading={sessionRefreshPending}
                aria-label={t("刷新会话")}
                onClick={() => void refreshSession(true).catch(() => undefined)}
                title={t("刷新会话")}
              />
            </div>
          </div>
            {events.length > 0 ? (
              <MobileSessionInteraction events={events} />
            ) : (
              <div className={styles.empty}>{t("未找到可读取的最近一轮")}</div>
            )}
          </div>
          {expanded && !sessionAtBottom ? (
            <div
              className={styles.scrollBottomControl}
              data-unseen-content={hasUnseenSessionContent || undefined}
            >
              <Button
                type="primary"
                theme="solid"
                icon={<IconChevronDown />}
                aria-label={hasUnseenSessionContent ? t("有新内容，滚动到底部") : t("滚动到底部")}
                title={hasUnseenSessionContent ? t("有新内容，滚动到底部") : t("滚动到底部")}
                onClick={scrollSessionToBottom}
              />
            </div>
          ) : null}
        </div>
        {session.agentType === "opencode" ? (
          <footer className={styles.footer}>
            <RemoteApprovalActions session={session} />
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function RemoteApprovalActions({ session }: { session: SharedAgentSession }) {
  const { t } = useAppPreferences();
  const permissions = useMobileRemotePermissions(session.deviceId, session.sessionId, true);
  const reply = useReplyMobileRemotePermission(session.deviceId, session.sessionId);

  if (permissions.isLoading || (permissions.isFetching && !permissions.data?.available)) {
    return session.runtimeStatus === "waiting_user"
      ? <div className={styles.remoteApprovalState}>{t("正在连接 Agent 所在设备…")}</div>
      : null;
  }
  if (permissions.isError) {
    return session.runtimeStatus === "waiting_user" ? (
      <div className={styles.remoteApprovalState} data-error="true">
        {t("OpenCode 待确认操作读取失败：{message}", { message: permissions.error.message })}
      </div>
    ) : null;
  }
  if (!permissions.data?.available) {
    return session.runtimeStatus === "waiting_user" ? (
      <div
        className={styles.remoteApprovalState}
        data-error="true"
        title={permissions.data?.error ?? undefined}
      >
        <strong>{t("OpenCode 控制服务未连接")}</strong>
        <span>{t("请重新应用 OpenCode 全局接入配置并重启 OpenCode；之后可在这里同意或否决待确认操作。")}</span>
      </div>
    ) : null;
  }
  if (permissions.data.permissions.length === 0) {
    return session.runtimeStatus === "waiting_user"
      ? <div className={styles.remoteApprovalState}>{t("该确认请求已处理或已过期。")}</div>
      : null;
  }

  const decide = async (permissionId: string, decision: "allow_once" | "reject") => {
    try {
      await reply.mutateAsync({ permissionId, decision });
      Toast.success(decision === "allow_once" ? t("已同意 OpenCode 本次操作") : t("已否决 OpenCode 操作"));
    } catch (error) {
      Toast.error(t("OpenCode 操作提交失败：{message}", {
        message: errorMessage(error),
      }));
    }
  };

  return (
    <div className={styles.remoteApprovalList}>
      {permissions.data.permissions.map((permission) => {
        const submitting = reply.isPending && reply.variables?.permissionId === permission.id;
        return (
          <div className={styles.remoteApproval} key={permission.id}>
            <div>
              <strong>{permission.permission}</strong>
              {permission.patterns.length > 0 ? <span>{permission.patterns.join(" · ")}</span> : null}
            </div>
            <div className={styles.remoteApprovalActions}>
              <Button
                size="small"
                type="danger"
                theme="borderless"
                loading={submitting && reply.variables?.decision === "reject"}
                disabled={reply.isPending && !submitting}
                onClick={() => void decide(permission.id, "reject")}
              >
                {t("否决")}
              </Button>
              <Button
                size="small"
                type="primary"
                theme="solid"
                loading={submitting && reply.variables?.decision === "allow_once"}
                disabled={reply.isPending && !submitting}
                onClick={() => void decide(permission.id, "allow_once")}
              >
                {t("同意本次")}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function sessionInteractionVersion(events: SyncedAgentInteractionEvent[]) {
  return events.map((event) => [
    event.id,
    event.timestamp,
    event.status ?? "",
    event.title ?? "",
    event.content ?? "",
  ].join("\u0000")).join("\u0001");
}

export function agentLabel(agentType: string) {
  switch (agentType) {
    case "claude-code": return "Claude Code";
    case "codex-desktop": return "Codex";
    case "codex-cli": return "Codex CLI";
    case "opencode": return "OpenCode";
    case "pi": return "Pi";
    default: return agentType;
  }
}

export function runtimeLabel(status: SharedAgentSession["runtimeStatus"], t: (key: string) => string) {
  switch (status) {
    case "running": return t("自动运行中");
    case "waiting_user": return t("等待用户确认");
    case "idle": return t("空闲");
    default: return t("状态未知");
  }
}
