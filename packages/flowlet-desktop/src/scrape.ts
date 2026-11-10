// 控制台抓取（CDP）。
//
// Rust 在 Windows 用 WebView2 原生响应捕获、Linux 用 WebKitGTK resource API，
// macOS 只有页面注入 fallback；Electron 统一为 `webContents.debugger`（CDP），
// 三平台同一实现。
//
// 登录态：每个账号一个 `persist:scrape-<accountId>` partition（Electron 的隔离
// 单位不是 Rust 的 per-account user-data-dir，但 cookie/localStorage/IndexedDB/
// cache 同样按账号隔离）。主窗口用独立 `persist:main-webview`。
//
// 安全边界：抓取窗口加载任意第三方页面，必须 contextIsolation + sandbox +
// nodeIntegration:false，并拒绝权限请求与新窗口。
import { BrowserWindow, type Session } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLogger } from "./logger.ts";

/** 与 Rust `scrape_console.rs` 一致的桌面 Chrome UA（LongCat 设备检测需要）。 */
export const SCRAPE_DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SCRAPE_WINDOW_WIDTH = 1440;
const SCRAPE_WINDOW_HEIGHT = 900;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_WINDOWS = 3;

/**
 * 最小可用抓取计划。与 Rust `ScrapeModeRuntime` 的对应关系：
 * - consoleUrl / secondary / tertiary → 1–3 阶段导航；
 * - interceptorJs → document-start 注入（builtin config 里会调用
 *   `__TAURI_INTERNALS__.invoke('handle_intercepted_response', ...)`，宿主提供兼容 shim）；
 * - slotRules + requiredSlots → 按 URL 归类响应、收齐后视为捕获完成；
 * - extractorJs → 捕获完成后在页面执行，返回结构化结果。
 *
 * 该结构与 desktop-scrape 命令层对接；变更必须同步 docs/desktop-electron.md。
 */
export interface ScrapePlan {
  readonly consoleUrl?: string;
  readonly consoleUrlSecondary?: string;
  readonly consoleUrlTertiary?: string;
  readonly interceptorJs?: string;
  readonly extractorJs?: string;
  readonly requiredSlots?: string[];
  readonly slotRules?: ScrapeSlotRule[];
  readonly aggregate?: boolean;
  /** 第 1 阶段的 URL 匹配；未提供时所有 JSON / XHR 响应都进入 `default` 槽。 */
  readonly captureAllJson?: boolean;
  /**
   * 传给 extractor / scrape.evaluate 的第二个参数。命令层传对象
   * `{ keyPrefix, keyLastFour }`（与 Rust credential_context 一致），宿主原样 JSON 序列化。
   */
  readonly credential?: unknown;
  readonly timeoutMs?: number;
}

export interface ScrapeSlotRule {
  readonly slot: string;
  readonly urlContains?: string[];
  readonly urlRegex?: string;
  /**
   * 自定义抓取描述符的 `match:{kind:"fallback"}`：仅当没有显式规则命中时匹配任意 URL。
   * 与 Rust `custom_scrape::SlotRule` 的 fallback 语义一致。
   */
  readonly fallback?: boolean;
}

export interface ScrapeOpenPayload {
  readonly accountId: string;
  readonly url?: string;
  readonly partition?: string;
  readonly channelId?: string;
  readonly interactive?: boolean;
}

interface ScrapeSession {
  readonly accountId: string;
  readonly win: BrowserWindow;
  readonly partition: string;
  debuggerAttached: boolean;
  pending: Map<string, { url: string; mimeType: string }>;
  captured: { url: string; body: string }[];
  bodies: Map<string, string>;
  wired: boolean;
}

interface RunningPlan {
  cancelled: boolean;
}

export class ScrapeManager {
  private readonly logger: DesktopLogger;
  private readonly webviewRoot: string;
  private readonly sessions = new Map<string, ScrapeSession>();
  private readonly running = new Map<string, RunningPlan>();

  constructor(options: { logger: DesktopLogger; webviewRoot: string }) {
    this.logger = options.logger;
    this.webviewRoot = options.webviewRoot;
    mkdirSync(this.webviewRoot, { recursive: true });
  }

  private partitionFor(accountId: string, explicit?: string): string {
    if (explicit !== undefined && explicit !== "") return explicit;
    // Electron partition 名不能包含路径分隔符；accountId 是 UUID。
    const safe = accountId.replace(/[^A-Za-z0-9._-]/g, "_");
    return `persist:scrape-${safe}`;
  }

  private configureSession(target: Session, channelId: string | undefined): void {
    if (channelId === "longcat") {
      // Rust 只对 longcat 固定桌面 UA：千问控制台走阿里云 SSO，对 UA 变化敏感。
      target.setUserAgent(SCRAPE_DESKTOP_CHROME_UA);
    }
    target.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
  }

  private ensureSession(payload: ScrapeOpenPayload): ScrapeSession {
    const existing = this.sessions.get(payload.accountId);
    if (existing !== undefined && !existing.win.isDestroyed()) {
      if (payload.channelId !== undefined) this.configureSession(existing.win.webContents.session, payload.channelId);
      return existing;
    }
    if (this.sessions.size >= MAX_LIVE_WINDOWS) {
      // 与 Rust SCRAPE_WEBVIEW_MAX_LIVE 一致：超限时回收最旧窗口（登录态在 partition 里）。
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.closeConsole(oldest);
    }
    const partition = this.partitionFor(payload.accountId, payload.partition);
    // 目录与 Rust 的 `scrape-webview-<account_id>` 对齐（失败只告警，partition 仍工作）。
    try {
      mkdirSync(join(this.webviewRoot, `scrape-webview-${payload.accountId}`), { recursive: true });
    } catch (error) {
      this.logger.warn("创建抓取账号数据目录失败", {
        accountId: payload.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const win = new BrowserWindow({
      width: SCRAPE_WINDOW_WIDTH,
      height: SCRAPE_WINDOW_HEIGHT,
      show: false,
      title: "Flowlet · 控制台抓取",
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const targetSession = win.webContents.session;
    this.configureSession(targetSession, payload.channelId);
    const entry: ScrapeSession = {
      accountId: payload.accountId,
      win,
      partition,
      debuggerAttached: false,
      pending: new Map(),
      captured: [],
      bodies: new Map(),
      wired: false,
    };
    win.on("closed", () => {
      this.sessions.delete(payload.accountId);
      this.running.delete(payload.accountId);
    });
    this.sessions.set(payload.accountId, entry);
    this.logger.info("已创建控制台抓取窗口", { accountId: payload.accountId, partition });
    return entry;
  }

  async openConsole(payload: ScrapeOpenPayload): Promise<{ opened: boolean }> {
    const entry = this.ensureSession(payload);
    if (payload.url !== undefined && payload.url !== "") {
      // about:blank 已加载时导航；确保监听在导航前挂好（runPlan 走自己的 attach 流程）。
      if (entry.win.webContents.getURL() !== payload.url) await entry.win.loadURL(payload.url);
    } else {
      // Rust `build_scrape_webview` 初始加载 about:blank；没有文档时
      // executeJavaScript 会挂起。隐藏窗口的 about:blank 在部分环境不会触发
      // loadURL 的 promise 解决，因此不能无限等待：最多等 3s 后继续。
      await this.ensureBlankDocument(entry);
    }
    if (payload.interactive === true) this.surface(entry);
    return { opened: true };
  }

  closeConsole(accountId: string): null {
    const entry = this.sessions.get(accountId);
    this.running.delete(accountId);
    if (entry !== undefined) {
      if (entry.debuggerAttached) {
        try {
          entry.win.webContents.debugger.detach();
        } catch {
          /* 已 detach */
        }
      }
      if (!entry.win.isDestroyed()) entry.win.destroy();
      this.sessions.delete(accountId);
    }
    return null;
  }

  /** 登录/需人工处理时把隐藏窗口显示出来（与 Rust `surface_scrape_webview` 一致）。 */
  private surface(entry: ScrapeSession): void {
    if (entry.win.isDestroyed()) return;
    entry.win.setBounds({ x: 100, y: 100, width: SCRAPE_WINDOW_WIDTH, height: SCRAPE_WINDOW_HEIGHT });
    entry.win.show();
    entry.win.focus();
  }

  /** 为一个还没有文档的抓取窗口装载 about:blank（有文档时立即返回）。 */
  private async ensureBlankDocument(entry: ScrapeSession): Promise<void> {
    const wc = entry.win.webContents;
    if (wc.isDestroyed() || wc.getURL() !== "") return;
    const loaded = new Promise<void>((resolve) => {
      wc.once("did-finish-load", () => resolve());
    });
    void wc.loadURL("about:blank").catch(() => undefined);
    await Promise.race([loaded, delay(3000)]);
  }

  async probeLogin(accountId: string): Promise<{ loggedIn: boolean; url: string }> {
    const entry = this.sessions.get(accountId);
    if (entry === undefined || entry.win.isDestroyed()) {
      throw new Error("抓取窗口不存在，请先打开控制台");
    }
    const url = entry.win.webContents.getURL();
    let text = "";
    try {
      text = String(await entry.win.webContents.executeJavaScript("document.body?.innerText ?? ''", true));
    } catch {
      /* 页面尚未就绪：按 URL 判断 */
    }
    const loginUrl = /(?:^|\/)(?:login|signin|sign-in|auth|passport|sso)(?:\/|$|\?)/i.test(url);
    const loginText = /(登录|扫码登录|sign in|log in|login required)/i.test(text.slice(0, 4000));
    return { loggedIn: !loginUrl && !loginText, url };
  }

  async cancel(accountId: string): Promise<null> {
    const running = this.running.get(accountId);
    if (running !== undefined) running.cancelled = true;
    this.running.delete(accountId);
    return null;
  }

  /**
   * 在**已存在的**抓取窗口里直接执行 extractor，不导航、不等待网络。
   *
   * Rust `scrape_balance` 复用 probe 阶段捕获的同一批响应（`eval_with_callback`），
   * 不能为了提取再导航一次；`runPlan` 是“导航+捕获+提取”的一次性流程，无法满足该场景。
   */
  async evaluate(payload: {
    accountId: string;
    source: string;
    bundle?: unknown;
    credential?: unknown;
    timeoutMs?: number;
  }): Promise<{ result: unknown }> {
    const entry = this.sessions.get(payload.accountId);
    if (entry === undefined || entry.win.isDestroyed()) {
      throw new Error("抓取窗口未打开");
    }
    if (typeof payload.source !== "string" || payload.source.trim() === "") {
      throw new Error("scrape.evaluate 的 source 不能为空");
    }
    // 窗口刚创建时没有 document，executeJavaScript 会挂起；先确保 about:blank 已加载。
    await this.ensureBlankDocument(entry);
    const timeoutMs = payload.timeoutMs ?? EVALUATE_TIMEOUT_MS;
    const code = buildEvaluationCode(payload.source, payload.bundle, payload.credential);
    const evaluation = entry.win.webContents.executeJavaScript(code, true) as Promise<unknown>;
    try {
      const result = await withTimeout(
        evaluation,
        timeoutMs,
        `抓取脚本执行超时（${Math.round(timeoutMs)}ms）`,
      );
      return { result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 超时消息本身已可读，不要二次包装成 "抓取脚本执行失败：抓取脚本执行超时…"。
      throw message.startsWith("抓取脚本执行超时")
        ? error
        : new Error(`抓取脚本执行失败：${message}`);
    }
  }

  async runPlan(payload: { accountId: string; plan: ScrapePlan; timeoutMs?: number }): Promise<{ result: unknown }> {
    const plan = payload.plan;
    if (plan === null || typeof plan !== "object") throw new Error("抓取计划必须是对象");
    // 不在 ensureSession 里导航：必须先 attach CDP / 注入 interceptor，再 navigate。
    const entry = this.ensureSession({ accountId: payload.accountId });
    if (this.running.has(payload.accountId)) throw new Error("该账号已有抓取任务在运行");
    const running: RunningPlan = { cancelled: false };
    this.running.set(payload.accountId, running);
    const timeoutMs =
      payload.timeoutMs ?? plan.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      await this.attachNetwork(entry, plan);
      const stages = [plan.consoleUrl, plan.consoleUrlSecondary, plan.consoleUrlTertiary].filter(
        (url): url is string => typeof url === "string" && url !== "",
      );
      const bundles = new Map<string, string>();
      for (let index = 0; index < stages.length; index += 1) {
        if (running.cancelled) throw new Error("抓取已取消");
        entry.bodies.clear();
        entry.captured = [];
        await this.navigate(entry, stages[index] as string, plan, index === 0);
        await this.waitForCapture(entry, plan, stages[index] as string, timeoutMs);
        for (const [slot, body] of entry.bodies) {
          if (plan.aggregate === true && bundles.has(slot)) {
            bundles.set(slot, mergeJsonArrays(bundles.get(slot) as string, body));
          } else {
            bundles.set(slot, body);
          }
        }
      }

      let result: unknown = Object.fromEntries(
        [...bundles.entries()].map(([slot, body]) => [slot, parseMaybeJson(body)]),
      );
      if (typeof plan.extractorJs === "string" && plan.extractorJs.trim() !== "") {
        result = await this.evaluateExtractor(entry, plan, Object.fromEntries(bundles));
      }
      if (running.cancelled) throw new Error("抓取已取消");
      return { result };
    } finally {
      this.running.delete(payload.accountId);
    }
  }

  private async attachNetwork(entry: ScrapeSession, plan: ScrapePlan): Promise<void> {
    const wc = entry.win.webContents;
    if (!entry.debuggerAttached) {
      try {
        wc.debugger.attach("1.3");
        entry.debuggerAttached = true;
      } catch (error) {
        throw new Error(
          `附加 CDP 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      wc.debugger.on("detach", () => {
        entry.debuggerAttached = false;
      });
      wc.debugger.on("message", (_event, method, params) => {
        this.onCdpMessage(entry, method, params);
      });
    }
    await wc.debugger.sendCommand("Network.enable", {
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: MAX_BODY_BYTES,
    });
    await wc.debugger.sendCommand("Page.enable");
    if (typeof plan.interceptorJs === "string" && plan.interceptorJs.trim() !== "") {
      // 内置 config 的 interceptor 调用 `__TAURI_INTERNALS__.invoke`；提供兼容 shim，
      // 让沿用 Rust 配置的抓取脚本零改写运行。ACK 由宿主在 loading 事件后忽略。
      const shim = [
        "globalThis.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__ || {",
        "  invoke: () => Promise.resolve(null),",
        "};",
        plan.interceptorJs,
      ].join("\n");
      await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: shim });
    }
  }

  private onCdpMessage(
    entry: ScrapeSession,
    method: string,
    params: unknown,
  ): void {
    if (method === "Network.responseReceived") {
      const p = params as { requestId?: unknown; response?: { url?: unknown; mimeType?: unknown } };
      if (typeof p.requestId !== "string" || p.response === undefined) return;
      entry.pending.set(p.requestId, {
        url: typeof p.response.url === "string" ? p.response.url : "",
        mimeType: typeof p.response.mimeType === "string" ? p.response.mimeType : "",
      });
      return;
    }
    if (method !== "Network.loadingFinished") return;
    const p = params as { requestId?: unknown };
    if (typeof p.requestId !== "string") return;
    const pending = entry.pending.get(p.requestId);
    if (pending === undefined) return;
    entry.pending.delete(p.requestId);
    if (!isTextResponse(pending.mimeType)) return;
    void entry.win.webContents.debugger
      .sendCommand("Network.getResponseBody", { requestId: p.requestId })
      .then((body) => {
        const b = body as { body?: unknown; base64Encoded?: unknown };
        if (typeof b.body !== "string") return;
        if (b.body.length > MAX_BODY_BYTES) return;
        const text =
          b.base64Encoded === true ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
        entry.captured.push({ url: pending.url, body: text });
      })
      .catch((error: unknown) => {
        this.logger.warn("读取抓取响应体失败", {
          accountId: entry.accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async navigate(
    entry: ScrapeSession,
    url: string,
    plan: ScrapePlan,
    firstStage: boolean,
  ): Promise<void> {
    // 第一阶段如果窗口已在该 URL，避免重复导航打断 SSO。
    if (firstStage && entry.win.webContents.getURL() === url) return;
    await entry.win.loadURL(url);
    // 槽位规则决定哪些响应进入结果；在页面稳定后把已有 body 重新按规则归类。
    if (plan.slotRules !== undefined) {
      entry.bodies.clear();
    }
  }

  private async waitForCapture(
    entry: ScrapeSession,
    plan: ScrapePlan,
    currentUrl: string,
    timeoutMs: number,
  ): Promise<void> {
    const required = plan.requiredSlots ?? [];
    const rules = plan.slotRules ?? [];
    if (required.length === 0 && rules.length === 0) {
      // 没有声明槽位时，给页面一段时间产生业务响应即可。
      await delay(Math.min(timeoutMs, 1500));
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 把已捕获的响应按规则重新归类。
      const classified = classifyBodies(entry.captured, rules, currentUrl);
      if (required.length === 0) {
        if (classified.size > 0) {
          entry.bodies = classified;
          return;
        }
      } else if (numbersSatisfied(classified, required)) {
        entry.bodies = classified;
        return;
      }
      await delay(100);
    }
    throw new Error(
      required.length === 0
        ? `控制台抓取超时（${Math.round(timeoutMs / 1000)}s 内未捕获到匹配响应）`
        : `控制台抓取超时（${Math.round(timeoutMs / 1000)}s 内未收齐响应槽位）`,
    );
  }

  private async evaluateExtractor(
    entry: ScrapeSession,
    plan: ScrapePlan,
    bundles: Record<string, unknown>,
  ): Promise<unknown> {
    const source = plan.extractorJs as string;
    const code = buildEvaluationCode(source, bundles, plan.credential);
    return entry.win.webContents.executeJavaScript(code, true);
  }
}

/** 与 Rust `eval_with_callback` 的 10s 超时对齐；可用 payload.timeoutMs 覆盖。 */
const EVALUATE_TIMEOUT_MS = 10_000;

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    return text === undefined ? "null" : text;
  } catch (error) {
    throw new Error(`抓取参数无法 JSON 序列化：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `(<source>)(bundle, credential)`：source 与 `ScrapePlan.extractorJs` 同形态
 * （函数表达式或 async 函数），在页面主世界执行并等待 Promise。
 */
function buildEvaluationCode(source: string, bundle: unknown, credential: unknown): string {
  return `(async () => {
    const bundle = ${safeJson(bundle)};
    const credential = ${safeJson(credential)};
    const fn = (${source});
    if (typeof fn !== 'function') throw new Error('抓取脚本不是函数');
    return await fn(bundle, credential);
  })()`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isTextResponse(mimeType: string): boolean {
  if (mimeType === "") return true;
  return /json|text|javascript|xml|html|x-www-form-urlencoded/i.test(mimeType);
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mergeJsonArrays(left: string, right: string): string {
  const a = parseMaybeJson(left);
  const b = parseMaybeJson(right);
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a, ...b]);
  if (Array.isArray(a)) return JSON.stringify([...a, b]);
  if (Array.isArray(b)) return JSON.stringify([a, ...b]);
  return JSON.stringify([a, b]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchSlot(url: string, rules: ScrapeSlotRule[]): string | null {
  const primary = rules.filter((rule) => rule.fallback !== true);
  const fallback = rules.filter((rule) => rule.fallback === true);
  for (const rule of primary) {
    if (rule.urlContains !== undefined && rule.urlContains.some((part) => url.includes(part))) {
      return rule.slot;
    }
    if (rule.urlRegex !== undefined) {
      try {
        if (new RegExp(rule.urlRegex).test(url)) return rule.slot;
      } catch {
        // 非法正则视为不匹配；计划来自配置层，错误应在那里校验。
      }
    }
  }
  // custom_scrape `match:{kind:"fallback"}`：没有显式规则命中时才兜底。
  for (const rule of fallback) return rule.slot;
  return null;
}

function classifyBodies(
  captured: { url: string; body: string }[],
  rules: ScrapeSlotRule[],
  _currentUrl: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of captured) {
    const slot = rules.length === 0 ? "default" : matchSlot(item.url, rules);
    if (slot === null) continue;
    const existing = result.get(slot);
    if (existing === undefined) result.set(slot, item.body);
    else result.set(slot, mergeJsonArrays(existing, item.body));
  }
  return result;
}

function numbersSatisfied(bodies: Map<string, string>, required: string[]): boolean {
  return required.every((slot) => bodies.has(slot));
}