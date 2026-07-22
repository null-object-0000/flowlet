import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { accountCommands, type ScrapeBalanceResult } from "../../domains/account/commands";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type ScrapeState =
  | "idle"
  | "opening"
  | "navigating"
  | "collecting"
  | "extracting"
  | "need-login"
  | "success"
  | "error";

/** 抓取结果事件(scrape:result 载荷)。 */
type ScrapeResultEvent = { accountId: string; data: ScrapeBalanceResult };
/** 需要登录事件(scrape:need-login 载荷)。保留监听用于兼容/调试,
 *  但当前 need-login 态主要由 probeScrapeLogin 返回值驱动。 */
type ScrapeNeedLoginEvent = { accountId: string; channelId: string };

/**
 * 控制台抓取的 UX 编排 Hook。
 * 状态机:idle → opening → navigating → collecting → extracting → success/error。
 * 登录态由 probeScrapeLogin 显式探测:未登录则弹出 webview 并转入 need-login 态,
 * 等用户登录后点「登录完成,重新抓取」重试。
 */
export function useScrapeConsole() {
  const { t } = useAppPreferences();
  const [state, setState] = useState<ScrapeState>("idle");
  const [lastResult, setLastResult] = useState<ScrapeBalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const activeAccountId = useRef<string | null>(null);

  // 订阅 Rust 事件
  useEffect(() => {
    const unreturnsResult = listen<ScrapeResultEvent>("scrape:result", (event) => {
      const payload = event.payload;
      if (activeAccountId.current && payload.accountId !== activeAccountId.current) {
        return;
      }
      setLastResult(payload.data);
      setNeedLogin(false);
      setState("success");
      activeAccountId.current = null;
    });
    const unreturnsNeedLogin = listen<ScrapeNeedLoginEvent>("scrape:need-login", (event) => {
      const payload = event.payload;
      if (activeAccountId.current && payload.accountId !== activeAccountId.current) {
        return;
      }
      setNeedLogin(true);
      setState("need-login");
    });
    return () => {
      void unreturnsResult.then((unlisten) => unlisten());
      void unreturnsNeedLogin.then((unlisten) => unlisten());
    };
  }, []);

  const startScrape = useCallback(async (accountId: string) => {
    activeAccountId.current = accountId;
    setError(null);
    setNeedLogin(false);
    setState("opening");
    try {
      // 先打开后台 webview(隐藏)
      await accountCommands.openScrapeConsole(accountId);
      setState("navigating");
      // 显式探测登录态:未登录则弹出 webview 并转入 need-login 态,等用户登录后重试
      const status = await accountCommands.probeScrapeLogin(accountId);
      if (!status.is_logged_in) {
        setNeedLogin(true);
        setState("need-login");
        // 不清除 activeAccountId,retryScrape 会重用
        return;
      }
      // 已登录:继续拦截+收集+提取
      const result = await accountCommands.scrapeBalance(accountId);
      setLastResult(result);
      setNeedLogin(false);
      setState("success");
      activeAccountId.current = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setState("error");
      activeAccountId.current = null;
    }
  }, []);

  /** 用户完成登录后重试:直接再跑一次 scrape_balance(会重新探测登录态)。 */
  const retryScrape = useCallback(async (accountId: string) => {
    setError(null);
    setNeedLogin(false);
    await startScrape(accountId);
  }, [startScrape]);

  const dismiss = useCallback(() => {
    setState("idle");
    setError(null);
    setNeedLogin(false);
  }, []);

  const isScraping = state !== "idle" && state !== "success" && state !== "error" && state !== "need-login";

  return {
    state,
    lastResult,
    error,
    needLogin,
    isScraping,
    startScrape,
    retryScrape,
    dismiss,
    /** 给 UI 用的友好状态文案 */
    statusText: statusText(state, error, t),
  };
}

function statusText(state: ScrapeState, error: string | null, t: (k: string) => string): string | null {
  switch (state) {
    case "opening":
      return t("正在打开控制台...");
    case "navigating":
      return t("正在加载控制台页面...");
    case "collecting":
      return t("正在拦截接口响应...");
    case "extracting":
      return t("正在解析数据...");
    case "error":
      return error;
    default:
      return null;
  }
}
