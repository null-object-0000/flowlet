import { useCallback, useEffect, useRef, useState } from "react";
import { accountCommands, type ScrapeBalanceResult } from "../../domains/account/commands";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type ScrapeState =
  | "idle"
  | "opening"
  | "navigating"
  | "collecting"
  | "extracting"
  | "need-login"
  | "need-console-action"
  | "success"
  | "error";

/**
 * 控制台抓取的 UX 编排 Hook。
 * 状态机:idle → opening → navigating → collecting → extracting → success/error。
 * probeScrapeLogin 会等待网络监听就绪并刷新页面。明确进入登录页时转入
 * need-login；监听已就绪但未捕获目标响应时转入 need-console-action，让用户在
 * 已展示的控制台中完成登录、验证码或等待页面加载，不能将其直接等同于未登录。
 */
export function useScrapeConsole(runScrape?: (accountId: string) => Promise<ScrapeBalanceResult>) {
  const { t } = useAppPreferences();
  const [state, setState] = useState<ScrapeState>("idle");
  const [lastResult, setLastResult] = useState<ScrapeBalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [consoleActionMessage, setConsoleActionMessage] = useState<string | null>(null);
  const activeAccountId = useRef<string | null>(null);

  // 卸载时释放仍被占用的隐藏控制台 WebView。
  //
  // 进入 need-login / need-console-action 时窗口是**故意**保留的，用户若直接关掉抽屉
  // 或切换渠道，就没有任何路径再关它：Rust 侧会把该账号标记为“等待人工处理”，后台
  // 同步从此永久跳过它，窗口也会一直占着 WebKit 子进程与文件描述符。
  //
  // StrictMode 安全性：React 在开发模式下的“挂载 → 卸载 → 再挂载”发生在首次挂载后
  // 立即执行，此时 activeAccountId.current 仍是 null，因此不会误关任何窗口。
  useEffect(() => () => {
    const accountId = activeAccountId.current;
    activeAccountId.current = null;
    if (accountId) {
      void accountCommands.closeScrapeConsole(accountId).catch(() => undefined);
    }
  }, []);

  const startScrape = useCallback(async (accountId: string) => {
    activeAccountId.current = accountId;
    setError(null);
    setNeedLogin(false);
    setConsoleActionMessage(null);
    setState("opening");
    try {
      setState("collecting");
      // probe 会先在 Rust 侧声明人工刷新所有权，再创建后台 WebView。不能在这里
      // 提前 open，否则可能撞上尚未结束的后台同步，被其清理逻辑关闭窗口。
      // 只有明确进入登录页才断言需要登录；监听已就绪后的捕获超时则提示用户
      // 在已展示的控制台中处理登录、验证码或页面加载，再主动重试。
      const status = await accountCommands.probeScrapeLogin(accountId);
      if (status.probe_state === "login_required") {
        setNeedLogin(true);
        setState("need-login");
        // 不清除 activeAccountId,retryScrape 会重用
        return;
      }
      if (status.probe_state === "console_action_required") {
        const message = status.message ?? t("未捕获到控制台业务响应，请在已打开的控制台中检查页面后重新抓取。");
        setConsoleActionMessage(message);
        setState("need-console-action");
        return;
      }
      if (status.probe_state === "capture_timeout") {
        throw new Error(status.message ?? t("控制台页面监听初始化失败，请重新抓取。"));
      }
      // 已捕获完整业务响应，继续提取并保存。
      const result = await (runScrape ?? accountCommands.scrapeBalance)(accountId);
      setLastResult(result);
      setNeedLogin(false);
      setState("success");
      activeAccountId.current = null;
    } catch (err) {
      // 登录/验证码分支会在上方提前返回并保留可见窗口；其余监听、提取或保存错误
      // 不需要 WebView 常驻，立即释放对应的 WebView2 子进程。登录态仍保存在
      // per-account 数据目录中，下次重试会按需重建窗口。
      await accountCommands.closeScrapeConsole(accountId).catch(() => undefined);
      const message = err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : err instanceof Error ? err.message : String(err);
      setError(message);
      setState("error");
      activeAccountId.current = null;
    }
  }, [runScrape, t]);

  /** 用户完成登录后重试：重新建立监听 ACK、刷新并抓取。 */
  const retryScrape = useCallback(async (accountId: string) => {
    setError(null);
    setNeedLogin(false);
    setConsoleActionMessage(null);
    await startScrape(accountId);
  }, [startScrape]);

  const dismiss = useCallback(() => {
    // 用户主动结束本次控制台交互：把仍然保留的窗口一并释放。
    const accountId = activeAccountId.current;
    activeAccountId.current = null;
    if (accountId) {
      void accountCommands.closeScrapeConsole(accountId).catch(() => undefined);
    }
    setState("idle");
    setError(null);
    setNeedLogin(false);
    setConsoleActionMessage(null);
  }, []);

  const isScraping = state !== "idle"
    && state !== "success"
    && state !== "error"
    && state !== "need-login"
    && state !== "need-console-action";

  return {
    state,
    lastResult,
    error,
    needLogin,
    consoleActionMessage,
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
      return t("正在刷新控制台并等待接口响应...");
    case "extracting":
      return t("正在解析数据...");
    case "error":
      return error;
    default:
      return null;
  }
}
