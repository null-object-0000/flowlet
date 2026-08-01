import { IconClose } from "@douyinfe/semi-icons";
import { Button, Toast } from "@douyinfe/semi-ui-19";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SharedAgentSession } from "../domains/device-sync/types";
import {
  useMobileRemotePermissions,
  useReplyMobileRemotePermission,
} from "../features/device-sync/useMobileDeviceSync";
import { formatFullTimestamp } from "../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../shared/formatters/number";
import { APP_OVERLAY_Z_INDEX } from "../shared/ui/overlayLayers";
import { MobileSessionInteraction } from "./MobileSessionInteraction";
import styles from "./MobileSessionSheet.module.css";

const CLOSE_ANIMATION_MS = 200;

/**
 * 会话详情底部弹窗：从会话卡片点开后展示会话身份、指标和完整「最近一轮」，
 * OpenCode 会话在底部粘性区域直接审批，让用户先看清上下文再做决定。
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
  const closeTimer = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sessionKey = session ? `${session.deviceId}:${session.agentType}:${session.sessionId}` : null;

  const requestClose = useCallback(() => {
    setClosing((wasClosing) => {
      if (!wasClosing) {
        closeTimer.current = window.setTimeout(onClose, CLOSE_ANIMATION_MS);
      }
      return true;
    });
  }, [onClose]);

  // 会话切换或重新打开时复位退出动画并聚焦关闭按钮。
  useEffect(() => {
    setClosing(false);
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (sessionKey) closeButtonRef.current?.focus({ preventScroll: true });
  }, [sessionKey]);

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
    if (!sessionKey) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sessionKey]);

  if (!session) return null;
  const title = session.title?.trim() || t("未命名会话");
  const events = session.lastInteraction?.events ?? [];

  return (
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
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          ref={closeButtonRef}
          className={styles.handle}
          aria-label={t("关闭")}
          onClick={requestClose}
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
            {session.clientName ? <span>{session.clientName}</span> : null}
            <span>{t("最近活跃：{time}", { time: formatFullTimestamp(session.activityAt, language) })}</span>
          </div>
        </header>
        <div className={styles.body}>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span>Tokens</span>
              <strong>{formatCompactNumber(session.knownTokens, language)}</strong>
            </div>
            <div className={styles.stat}>
              <span>{t("请求数")}</span>
              <strong>{formatInteger(session.requestCount, language)}</strong>
            </div>
            <div className={styles.stat} data-error={session.errorCount > 0 || undefined}>
              <span>{t("失败")}</span>
              <strong>{formatInteger(session.errorCount, language)}</strong>
            </div>
          </div>
          <h3 className={styles.sectionLabel}>{t("最近一轮")}</h3>
          {events.length > 0 ? (
            <MobileSessionInteraction events={events} />
          ) : (
            <div className={styles.empty}>{t("未找到可读取的最近一轮")}</div>
          )}
        </div>
        {session.agentType === "opencode" ? (
          <footer className={styles.footer}>
            <RemoteApprovalActions session={session} />
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function RemoteApprovalActions({ session }: { session: SharedAgentSession }) {
  const { t } = useAppPreferences();
  const permissions = useMobileRemotePermissions(session.deviceId, session.sessionId, true);
  const reply = useReplyMobileRemotePermission(session.deviceId, session.sessionId);

  if (permissions.isLoading) {
    return session.runtimeStatus === "waiting_user"
      ? <div className={styles.remoteApprovalState}>{t("正在连接 Agent 所在设备…")}</div>
      : null;
  }
  if (permissions.isError || !permissions.data?.available) {
    return session.runtimeStatus === "waiting_user" ? (
      <div className={styles.remoteApprovalState} data-error="true">
        {t("目标设备当前无法直连，请确认两台设备位于同一局域网。")}
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
        message: error instanceof Error ? error.message : String(error),
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
