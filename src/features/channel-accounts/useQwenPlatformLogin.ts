import { useCallback, useEffect, useRef, useState } from "react";
import {
  qwenPlatformCommands,
  type QwenPlatformLoginPoll,
  type QwenPlatformLoginStart,
  type QwenPlatformStatus,
  type QwenPlatformSyncResult,
} from "../../domains/account/qwenPlatform";
import { openExternalUrl } from "../../platform/openExternal";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { errorMessage } from "../../shared/errors/AppError";

/**
 * 千问平台登录（device flow）+ HTTP 同步的 UX 状态机。
 *
 * 状态：
 *   idle      → 未开始登录（或已取消/刚退出登录）
 *   starting  → 已请求 login_start，正在打开浏览器
 *   waiting   → 已打开浏览器授权页，按 intervalSeconds 轮询
 *   syncing   → 登录完成后的自动同步，或用户手动「立即刷新」
 *   success   → 同步成功
 *   error     → 登录/轮询/同步失败，`error` 为可读文案
 *
 * StrictMode 安全：
 * - 每次登录发起都会获得新的 session 序号，轮询回调只在序号仍匹配时生效；
 * - 卸载或 accountId/enabled 变化时 effect cleanup 会失效序号并清掉定时器，
 *   在途的 login_poll / sync 结果也会因序号不匹配而被丢弃，不会落到新账号上。
 */

export type QwenPlatformPhase = "idle" | "starting" | "waiting" | "syncing" | "success" | "error";

/** 错误归属：登录流程（含登录态读取、轮询、退出）或同步。面板据此就近展示。 */
export type QwenPlatformErrorScope = "login" | "sync";

export type UseQwenPlatformLoginOptions = {
  accountId: string;
  /** 新建但未保存的账号没有服务端 id，设为 false 时不读取状态也不能登录。 */
  enabled?: boolean;
  /** 同步成功后回调（登录自动同步与手动刷新都会触发），供页面失效余额快照等 query。 */
  onSynced?: (result: QwenPlatformSyncResult) => void;
};

export type UseQwenPlatformLoginResult = {
  status: QwenPlatformStatus | null;
  statusLoading: boolean;
  phase: QwenPlatformPhase;
  isPolling: boolean;
  isSyncing: boolean;
  waitingForBrowser: boolean;
  isLoggedIn: boolean;
  loginStart: QwenPlatformLoginStart | null;
  lastSync: QwenPlatformSyncResult | null;
  error: string | null;
  errorScope: QwenPlatformErrorScope | null;
  startLogin: () => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
  syncNow: () => Promise<QwenPlatformSyncResult | null>;
  refreshStatus: () => Promise<void>;
};

/** RFC 8628：收到 slow_down 后轮询间隔至少 +5 秒。 */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

export function useQwenPlatformLogin({
  accountId,
  enabled = true,
  onSynced,
}: UseQwenPlatformLoginOptions): UseQwenPlatformLoginResult {
  const { t } = useAppPreferences();
  const [status, setStatus] = useState<QwenPlatformStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [phase, setPhase] = useState<QwenPlatformPhase>("idle");
  const [loginStart, setLoginStart] = useState<QwenPlatformLoginStart | null>(null);
  const [lastSync, setLastSync] = useState<QwenPlatformSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<QwenPlatformErrorScope | null>(null);

  /** 每次登录流程的标识；卸载/切账号/取消会让当前流程失效。 */
  const sessionRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(5);
  const syncingRef = useRef(false);
  /** 避免把回调放进 effect/轮询依赖链导致重新挂载。 */
  const onSyncedRef = useRef(onSynced);
  const pollOnceRef = useRef<(session: number) => Promise<void>>(async () => undefined);

  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 停止轮询并让所有在途 poll/sync 结果失效。 */
  const stopPolling = useCallback(() => {
    sessionRef.current += 1;
    clearTimer();
  }, [clearTimer]);

  const fail = useCallback((scope: QwenPlatformErrorScope, message: string) => {
    setError(message);
    setErrorScope(scope);
    setPhase("error");
  }, []);

  const schedulePoll = useCallback((session: number) => {
    clearTimer();
    const delayMs = Math.max(1, intervalRef.current) * 1000;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (session !== sessionRef.current) return;
      void pollOnceRef.current(session);
    }, delayMs);
  }, [clearTimer]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    setStatusLoading(true);
    try {
      const next = await qwenPlatformCommands.status(accountId);
      if (session === sessionRef.current) setStatus(next);
    } catch (err) {
      if (session !== sessionRef.current) return;
      fail("login", t("读取登录状态失败：{message}", { message: errorMessage(err) }));
    } finally {
      if (session === sessionRef.current) setStatusLoading(false);
    }
  }, [accountId, fail, t]);

  /** 登录完成：先乐观标记已登录，再自动同步一次并回读真实状态。 */
  const finishLogin = useCallback(async (session: number) => {
    if (session !== sessionRef.current) return;
    setPhase("syncing");
    setError(null);
    setErrorScope(null);
    setStatus((current) => current?.loggedIn
      ? current
      : { accountId, loggedIn: true, aliyunId: current?.aliyunId ?? null, email: current?.email ?? null, expiresAt: current?.expiresAt ?? null });

    let synced: QwenPlatformSyncResult | null = null;
    try {
      synced = await qwenPlatformCommands.sync(accountId);
    } catch (err) {
      if (session !== sessionRef.current) return;
      fail("sync", t("登录成功，但同步失败：{message}", { message: errorMessage(err) }));
    }

    if (session !== sessionRef.current) return;
    const nextStatus = await qwenPlatformCommands.status(accountId).catch(() => null);
    if (session !== sessionRef.current) return;
    if (nextStatus) setStatus(nextStatus);

    if (synced) {
      setLastSync(synced);
      onSyncedRef.current?.(synced);
      setError(null);
      setErrorScope(null);
      setPhase("success");
    }
  }, [accountId, fail, t]);

  const pollOnce = useCallback(async (session: number) => {
    if (session !== sessionRef.current) return;
    let result: QwenPlatformLoginPoll;
    try {
      result = await qwenPlatformCommands.loginPoll(accountId);
    } catch (err) {
      if (session !== sessionRef.current) return;
      stopPolling();
      setLoginStart(null);
      fail("login", t("轮询登录状态失败：{message}", { message: errorMessage(err) }));
      return;
    }
    if (session !== sessionRef.current) return;

    switch (result.status) {
      case "pending":
        schedulePoll(session);
        return;
      case "slow_down":
        intervalRef.current += SLOW_DOWN_INCREMENT_SECONDS;
        schedulePoll(session);
        return;
      case "complete":
        clearTimer();
        await finishLogin(session);
        return;
      case "expired":
        stopPolling();
        setLoginStart(null);
        fail("login", t("登录已过期请重新登录"));
        return;
      case "denied":
        stopPolling();
        setLoginStart(null);
        fail("login", t("登录授权被拒绝，请重新登录"));
        return;
    }
  }, [accountId, clearTimer, fail, finishLogin, schedulePoll, stopPolling, t]);

  useEffect(() => {
    pollOnceRef.current = pollOnce;
  });

  const startLogin = useCallback(async () => {
    stopPolling();
    const session = sessionRef.current;
    setLoginStart(null);
    setError(null);
    setErrorScope(null);
    setPhase("starting");

    let started: QwenPlatformLoginStart;
    try {
      started = await qwenPlatformCommands.loginStart(accountId);
    } catch (err) {
      if (session !== sessionRef.current) return;
      fail("login", t("登录失败：{message}", { message: errorMessage(err) }));
      return;
    }
    if (session !== sessionRef.current) return;

    setLoginStart(started);
    intervalRef.current = Math.max(1, Math.floor(started.intervalSeconds || 5));
    setPhase("waiting");

    try {
      const outcome = await openExternalUrl(started.verificationUrl);
      if (session !== sessionRef.current) return;
      if (outcome === "blocked") {
        setError(t("浏览器拦截了登录窗口，请允许弹出窗口后重试。"));
        setErrorScope("login");
      }
    } catch (err) {
      if (session !== sessionRef.current) return;
      setError(t("无法打开登录页面：{message}", { message: errorMessage(err) }));
      setErrorScope("login");
    }
    if (session !== sessionRef.current) return;
    schedulePoll(session);
  }, [accountId, fail, schedulePoll, stopPolling, t]);

  const cancelLogin = useCallback(() => {
    stopPolling();
    setLoginStart(null);
    setError(null);
    setErrorScope(null);
    setPhase("idle");
  }, [stopPolling]);

  const logout = useCallback(async () => {
    stopPolling();
    setLoginStart(null);
    setLastSync(null);
    setError(null);
    setErrorScope(null);
    setPhase("idle");
    const session = sessionRef.current;
    setStatusLoading(true);
    try {
      await qwenPlatformCommands.logout(accountId);
      if (session !== sessionRef.current) return;
      setStatus({ accountId, loggedIn: false, aliyunId: null, email: null, expiresAt: null });
    } catch (err) {
      if (session !== sessionRef.current) return;
      fail("login", t("退出登录失败：{message}", { message: errorMessage(err) }));
    } finally {
      if (session === sessionRef.current) setStatusLoading(false);
    }
  }, [accountId, fail, stopPolling, t]);

  const syncNow = useCallback(async (): Promise<QwenPlatformSyncResult | null> => {
    if (syncingRef.current) return null;
    syncingRef.current = true;
    const session = sessionRef.current;
    setPhase("syncing");
    setError(null);
    setErrorScope(null);
    try {
      const result = await qwenPlatformCommands.sync(accountId);
      if (session !== sessionRef.current) return null;
      setLastSync(result);
      onSyncedRef.current?.(result);
      setPhase("success");
      return result;
    } catch (err) {
      if (session !== sessionRef.current) return null;
      fail("sync", t("同步失败：{message}", { message: errorMessage(err) }));
      return null;
    } finally {
      syncingRef.current = false;
    }
  }, [accountId, fail, t]);

  // 挂载 / accountId 变化 / 启停变化：重置状态并读取登录态。
  // StrictMode 的“挂载 → 卸载 → 再挂载”只会让第一次读取结果被丢弃，不会重复轮询。
  useEffect(() => {
    sessionRef.current += 1;
    const session = sessionRef.current;
    clearTimer();
    setStatus(null);
    setStatusLoading(false);
    setPhase("idle");
    setLoginStart(null);
    setLastSync(null);
    setError(null);
    setErrorScope(null);

    if (!enabled) return;

    let cancelled = false;
    setStatusLoading(true);
    void qwenPlatformCommands.status(accountId).then((next) => {
      if (cancelled || session !== sessionRef.current) return;
      setStatus(next);
      setStatusLoading(false);
    }).catch((err: unknown) => {
      if (cancelled || session !== sessionRef.current) return;
      setStatusLoading(false);
      setError(t("读取登录状态失败：{message}", { message: errorMessage(err) }));
      setErrorScope("login");
    });

    return () => {
      cancelled = true;
      if (session === sessionRef.current) sessionRef.current += 1;
      clearTimer();
    };
  }, [accountId, enabled, clearTimer, t]);

  const isPolling = phase === "starting" || phase === "waiting";
  return {
    status,
    statusLoading,
    phase,
    isPolling,
    isSyncing: phase === "syncing",
    waitingForBrowser: phase === "waiting",
    isLoggedIn: status?.loggedIn === true,
    loginStart,
    lastSync,
    error,
    errorScope,
    startLogin,
    cancelLogin,
    logout,
    syncNow,
    refreshStatus,
  };
}