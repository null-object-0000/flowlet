// per-account 抓取会话状态机（Rust AppState 中 scrape_* 各字段的等价实现）。
//
// Rust 的状态分散在 AppState：
// - `scrape_webviews`      → 窗口由 Electron 宿主持有，命令层只记「已打开」；
// - `scrape_pending`       → per-account 已捕获响应缓冲 `Vec<(url, body)>`；
// - `scrape_modes`         → per-account 抓取模式（解析一次的 ScrapeModeRuntime）；
// - `scrape_ready`         → document-start 拦截器 ACK（document_id / page_url）；
// - `scrape_native_ready`  → 原生监听已生效（Electron 侧 = CDP 已 attach）；
// - `scrape_interaction_required` → 账号等待人工登录/处理（后台同步跳过它）；
// - `scrape_interactive_sessions` → 该账号正被人工刷新接管（后台同步不得关窗口）。
//
// 命令层必须持有这些状态：`handle_intercepted_response` /
// `handle_scrape_interceptor_ready` 是页面回调入口，`probe_scrape_login` /
// `scrape_balance` 依赖同一份缓冲与「已就绪」事实。状态生命周期与 Rust 一致：
// 关闭控制台时全部清空（登录态在 partition 里，不依赖状态）。
import type { ScrapeMode } from "./slot-engine.ts";

/** Rust `ScrapeInterceptorReady`。 */
export interface ScrapeInterceptorReady {
  documentId: string;
  pageUrl: string;
}

export interface ScrapeSession {
  readonly accountId: string;
  readonly channelId: string;
  mode: ScrapeMode;
  /** Rust `scrape_pending`：页面 IPC 回传的原始响应（URL, body）。 */
  pending: Array<[string, string]>;
  /** runPlan 逐阶段返回的槽位结果（slot → 原始 JSON 文本）。 */
  slots: Map<string, string>;
  /** Rust `scrape_ready`。 */
  ready: ScrapeInterceptorReady | null;
  /** Rust `scrape_native_ready`：Electron 侧 CDP 已 attach。 */
  nativeReady: boolean;
  /** 最近一次探到的页面 URL（宿主 probeLogin 返回）。 */
  pageUrl: string | null;
}

/** Rust `SCRAPE_WEBVIEW_MAX_LIVE`。 */
export const SCRAPE_WEBVIEW_MAX_LIVE = 3;
/** Rust `MAX_SCRAPED_RESPONSE_BYTES`。 */
export const MAX_SCRAPED_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Rust `handle_scrape_interceptor_ready` 的参数上限。 */
export const MAX_DOCUMENT_ID_LENGTH = 128;
export const MAX_INTERCEPTOR_PAGE_URL_LENGTH = 4096;

/** 进程内抓取会话存储。命令层单例；Web Host 上永远不会创建。 */
export class ScrapeSessionStore {
  private readonly sessions = new Map<string, ScrapeSession>();
  private readonly interactionRequired = new Set<string>();
  private readonly interactiveSessions = new Set<string>();

  list(): ScrapeSession[] {
    return [...this.sessions.values()];
  }

  get(accountId: string): ScrapeSession | undefined {
    return this.sessions.get(accountId);
  }

  /** 当前唯一活跃会话；用于「页面回调 payload 没有 accountId」的分派。 */
  only(): ScrapeSession | undefined {
    return this.sessions.size === 1 ? this.sessions.values().next().value : undefined;
  }

  size(): number {
    return this.sessions.size;
  }

  open(accountId: string, channelId: string, mode: ScrapeMode): ScrapeSession {
    const existing = this.sessions.get(accountId);
    if (existing !== undefined) {
      existing.mode = mode;
      return existing;
    }
    const session: ScrapeSession = {
      accountId,
      channelId,
      mode,
      pending: [],
      slots: new Map(),
      ready: null,
      nativeReady: false,
      pageUrl: null,
    };
    this.sessions.set(accountId, session);
    return session;
  }

  /**
   * Rust `destroy_scrape_webview`：销毁窗口并清除全部 per-account 状态，
   * 包括人工刷新/等待人工处理标记（否则账号会被永久跳过自动同步）。
   */
  close(accountId: string): ScrapeSession | undefined {
    const session = this.sessions.get(accountId);
    this.sessions.delete(accountId);
    this.interactionRequired.delete(accountId);
    this.interactiveSessions.delete(accountId);
    return session;
  }

  /** 回收最旧的会话（宿主窗口上限一致）。 */
  evictOldest(): string | undefined {
    const oldest = this.sessions.keys().next().value;
    if (oldest === undefined) return undefined;
    this.close(oldest);
    return oldest;
  }

  /** 清空缓冲与就绪状态（Rust probe 开始前的清缓冲语义）。 */
  resetCapture(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session === undefined) return;
    session.pending = [];
    session.slots = new Map();
    session.ready = null;
  }

  setReady(accountId: string, ready: ScrapeInterceptorReady): void {
    const session = this.sessions.get(accountId);
    if (session === undefined) return;
    session.ready = ready;
  }

  markNativeReady(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session === undefined) return;
    session.nativeReady = true;
  }

  isInteractionRequired(accountId: string): boolean {
    return this.interactionRequired.has(accountId);
  }

  setInteractionRequired(accountId: string, required: boolean): void {
    if (required) this.interactionRequired.add(accountId);
    else this.interactionRequired.delete(accountId);
  }

  isInteractiveSessionActive(accountId: string): boolean {
    return this.interactiveSessions.has(accountId);
  }

  setInteractiveSessionActive(accountId: string, active: boolean): void {
    if (active) this.interactiveSessions.add(accountId);
    else this.interactiveSessions.delete(accountId);
  }
}

/**
 * 命令层单例。放在模块作用域而不是 `DesktopContext` 上：Rust 侧同样是
 * AppState 的进程级字段，且桌面命令 dispatch 在每个 HTTP 请求间不保留上下文实例。
 */
export const scrapeSessions = new ScrapeSessionStore();

/** 测试用：重置全部会话状态。 */
export function resetScrapeSessionsForTests(): void {
  for (const accountId of scrapeSessions.list().map((session) => session.accountId)) {
    scrapeSessions.close(accountId);
  }
}