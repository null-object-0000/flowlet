// 桌面控制台抓取与目录/余额同步命令（批次 4）。Owner: desktop-scrape。
//
// 负责：open_scrape_console / close_scrape_console / handle_intercepted_response /
// handle_scrape_interceptor_ready / probe_scrape_login / scrape_balance /
// sync_scrape_balances / open_external_url / reload_custom_scrape_registry /
// list_balance_snapshots。
//
// 权威行为：src-tauri/src/commands/scrape.rs 与 core/scrape_console.rs。
// Electron 侧改为统一 CDP（channel `scrape.*`，见 desktop/README.md 的 channel 契约）；
// 登录态目录 per-account 隔离，既有 WebView 登录态无法迁移，需引导用户重新登录。
//
// 分工（与宿主 `packages/flowlet-desktop/src/scrape.ts` 的边界）：
// - 宿主负责「窗口 + CDP 抓包 + 页面执行」：导航、Network.* 捕获、在页面里跑 extractor；
// - 命令层负责「模式解析 + 槽位语义 + 完成判定 + 会话状态机 + 落库 + 错误映射」：
//   config.json / 自定义描述符驱动 ScrapePlan，逐阶段收槽位并按 Rust 语义合并/校验；
// - 页面注入的 `__TAURI_INTERNALS__.invoke('handle_intercepted_response' ...)` 在
//   Electron 侧是 resolve-null shim（CDP 为准），两条 handle_* 命令仍保留为同一语义的
//   页面回调入口：宿主若转发 IPC（需补 accountId）即可写入同一份会话缓冲。
import { randomUUID } from "node:crypto";

import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import { argOptionalBool, argOptionalString, argString, argsObject } from "../web/errors.ts";
import { effectiveOpenaiBaseUrl } from "../web/config-state.ts";
import { queryBalance } from "../web/balance.ts";
import {
  isCredentialsExpired,
  platformAccountKind,
  resolveAccountCredentials,
  syncAccount as syncQwenPlatformAccount,
} from "../web/qwen-platform.ts";
import {
  addJobEvent,
  createJob,
  finishJob,
  updateJobProgress,
} from "../storage/background-jobs.ts";
import { listBalanceSnapshots, saveBalanceSnapshot } from "../storage/scrape.ts";
import {
  classifySlot,
  collectSlots,
  aggregateComplete,
  buildAggregateBundle,
  isExplicitLoginUrl,
  mergeSlot,
  missingRequiredSlots,
  recordCapturedResponse,
  requiredSlotsForPhase,
  scrapePhases,
  singleResponseTargetSlot,
  slotSatisfied,
  builtinSlotRules,
  customSlotRules,
  type ScrapeMode,
  type ScrapePlanRule,
} from "../scrape/slot-engine.ts";
import {
  buildExtractorSource,
  credentialKeyContext,
  parseExtractorOutput,
  readExtractedBalance,
} from "../scrape/extractor.ts";
import { normalizeScrapeTokenPacks } from "../scrape/token-packs.ts";
import { presetSupportsBalanceQuery, resolveScrapeMode } from "../scrape/mode.ts";
import {
  MAX_DOCUMENT_ID_LENGTH,
  MAX_INTERCEPTOR_PAGE_URL_LENGTH,
  MAX_SCRAPED_RESPONSE_BYTES,
  SCRAPE_WEBVIEW_MAX_LIVE,
  scrapeSessions,
  type ScrapeSession,
} from "../scrape/session.ts";
import {
  listCustomScrapeChannelInfos,
  reloadCustomScrapeRegistry,
  type CustomScrapeChannelInfo,
} from "../scrape/custom-registry.ts";

/** Rust `ScrapeBalanceResult`（snake_case）。 */
export interface ScrapeBalanceResult {
  balance: number | null;
  currency: string | null;
  plan_name: string | null;
  token_total: number | null;
  token_used: number | null;
  token_remaining: number | null;
  token_pack_expire_at: string | null;
  token_packs: string | null;
  raw_scraped_json: string | null;
  source: string;
  synced_at: string;
}

/** Rust `ScrapeLoginStatus`（snake_case）。 */
export interface ScrapeLoginStatus {
  is_logged_in: boolean;
  channel_id: string;
  account_hint: string | null;
  probe_state: "captured" | "login_required" | "console_action_required" | "capture_timeout";
  message: string | null;
}

/** Rust `ScrapeBalanceSyncResult`（camelCase）。 */
export interface ScrapeBalanceSyncResult {
  started: boolean;
  jobId: string | null;
  accounts: number;
  synced: number;
  failed: number;
  message: string;
}

/** 与宿主 `ScrapePlan` 同形（宿主定义在 packages/flowlet-desktop，命令层不 import）。 */
interface ScrapePlan {
  consoleUrl?: string;
  consoleUrlSecondary?: string;
  consoleUrlTertiary?: string;
  interceptorJs?: string;
  extractorJs?: string;
  requiredSlots?: string[];
  slotRules?: ScrapePlanRule[];
  aggregate?: boolean;
  captureAllJson?: boolean;
  credential?: JsonRow | null;
  timeoutMs?: number;
}

const DEFAULT_PLAN_TIMEOUT_MS = 30_000;
const EXTRACTOR_TIMEOUT_MS = 10_000;
const PROBE_PHASE_TIMEOUT_MS = 15_000;
/**
 * 写入主进程日志（`platform.logFromFrontend`，与 Rust `tracing::warn!` 语义对应）。
 * 纯诊断，宿主不可用/未实现时静默忽略，绝不影响抓取结果。
 */
function logFromFrontend(
  ctx: DesktopContext,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  detail?: JsonRow,
): void {
  void ctx.desktop.host
    .invoke("platform.logFromFrontend", {
      level,
      message: `[scrape] ${message}`,
      ...(detail === undefined ? {} : { detail }),
    })
    .catch(() => undefined);
}

function badRequest(message: string): CommandError {
  return CommandError.badRequest(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is JsonRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rust 账号查找：`runtime_config.snapshot().accounts`。 */
function findAccount(ctx: DesktopContext, accountId: string): JsonRow {
  const snapshot = ctx.runtimeConfig.snapshot();
  const accounts = Array.isArray(snapshot.accounts) ? (snapshot.accounts as JsonRow[]) : [];
  const account = accounts.find((item) => item?.id === accountId);
  if (account === undefined) throw badRequest("账号不存在");
  return account;
}

function accountFieldString(account: JsonRow, field: string): string {
  const value = account[field];
  return typeof value === "string" ? value : "";
}

function accountResourceMode(account: JsonRow): string | null {
  const value = account.resource_mode;
  return typeof value === "string" && value !== "" ? value : null;
}

function requireMode(
  ctx: DesktopContext,
  account: JsonRow,
): { channelId: string; mode: ScrapeMode } {
  const channelId = accountFieldString(account, "channel_id");
  const mode = resolveScrapeMode(
    ctx,
    channelId,
    accountResourceMode(account),
    accountFieldString(account, "name"),
  );
  if (mode === null) throw badRequest("该账号所属渠道不支持控制台抓取");
  return { channelId, mode };
}

// ─── ScrapePlan 构造（多阶段 URL + 槽位规则 + interceptor） ──────────────────

function slotRulesForMode(channelId: string, mode: ScrapeMode): ScrapePlanRule[] {
  if (mode.slotRules !== null) return customSlotRules(mode.slotRules);
  return builtinSlotRules(channelId, mode.requiredSlots);
}

/** 单阶段计划：interceptor 只在第一次执行时注入（宿主每次 runPlan 都会注入脚本）。 */
function planForPhase(
  channelId: string,
  mode: ScrapeMode,
  phaseUrl: string,
  phaseIndex: number,
  phaseCount: number,
  options: { interceptor?: boolean; timeoutMs?: number } = {},
): ScrapePlan {
  const required = requiredSlotsForPhase(mode, phaseIndex, phaseCount);
  const rules = slotRulesForMode(channelId, mode);
  const plan: ScrapePlan = {
    consoleUrl: phaseUrl,
    timeoutMs: options.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS,
  };
  if (rules.length > 0) plan.slotRules = rules;
  if (required.length > 0) plan.requiredSlots = required;
  if (options.interceptor === true && mode.interceptorJs.trim() !== "") {
    plan.interceptorJs = mode.interceptorJs;
  }
  return plan;
}

interface RunPlanOutcome {
  ok: boolean;
  slots: Record<string, unknown>;
  error: string | null;
}

async function runPlan(
  ctx: DesktopContext,
  accountId: string,
  plan: ScrapePlan,
): Promise<RunPlanOutcome> {
  try {
    const response = await ctx.desktop.host.invoke<{ result?: unknown }>("scrape.runPlan", {
      accountId,
      plan: plan as unknown as JsonRow,
      timeoutMs: plan.timeoutMs,
    });
    const result = isPlainObject(response) ? response.result : response;
    return { ok: true, slots: isPlainObject(result) ? result : {}, error: null };
  } catch (error) {
    return { ok: false, slots: {}, error: errorText(error) };
  }
}

/**
 * 逐阶段执行抓取计划，并按 Rust `record_captured_response` 的语义把各阶段槽位
 * 合并进会话缓冲。返回首个失败阶段的错误（若全部失败）与是否至少成功一个阶段。
 */
async function capturePhases(
  ctx: DesktopContext,
  session: ScrapeSession,
  channelId: string,
  mode: ScrapeMode,
  timeoutMs: number,
): Promise<{ anyPhaseOk: boolean; lastError: string | null }> {
  const phases = scrapePhases(mode);
  let anyPhaseOk = false;
  let lastError: string | null = null;
  for (let index = 0; index < phases.length; index += 1) {
    const plan = planForPhase(channelId, mode, phases[index] as string, index, phases.length, {
      interceptor: index === 0,
      timeoutMs,
    });
    const outcome = await runPlan(ctx, session.accountId, plan);
    if (!outcome.ok) {
      lastError = outcome.error ?? "控制台抓取失败";
      continue;
    }
    anyPhaseOk = true;
    absorbSlots(mode, session, outcome.slots);
  }
  return { anyPhaseOk, lastError };
}

/** 把宿主返回的槽位结果合并进会话（合并规则与 Rust 槽位引擎一致）。 */
function absorbSlots(mode: ScrapeMode, session: ScrapeSession, slots: JsonRow): void {
  for (const [slot, value] of Object.entries(slots)) {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    if (body === undefined) continue;
    if (!slotSatisfied(mode, slot, body)) continue;
    const existing = session.slots.get(slot);
    if (existing === undefined) {
      session.slots.set(slot, body);
      continue;
    }
    const merged = mergeSlot(mode, slot, existing, body);
    session.slots.set(slot, merged ?? body);
  }
}

// ─── 会话/窗口辅助 ──────────────────────────────────────────────────────────

async function hostCloseConsole(ctx: DesktopContext, accountId: string): Promise<void> {
  try {
    await ctx.desktop.host.invoke("scrape.closeConsole", { accountId });
  } catch {
    // 窗口已销毁/宿主未打开过该账号：关闭是幂等的，Rust 同样忽略失败。
  }
}

/** Rust `destroy_scrape_webview` + 数据目录语义：关闭窗口并清空全部 per-account 状态。 */
async function destroyConsole(ctx: DesktopContext, accountId: string): Promise<void> {
  scrapeSessions.close(accountId);
  await hostCloseConsole(ctx, accountId);
}

/** Rust `reclaim_stale_scrape_webviews`：回收不属于人工刷新、且不是本次账号的会话。 */
async function reclaimStaleSessions(ctx: DesktopContext, keepAccountId: string): Promise<number> {
  let reclaimed = 0;
  for (const session of scrapeSessions.list()) {
    if (session.accountId === keepAccountId) continue;
    if (scrapeSessions.isInteractiveSessionActive(session.accountId)) continue;
    await destroyConsole(ctx, session.accountId);
    reclaimed += 1;
  }
  return reclaimed;
}

async function openConsoleWindow(
  ctx: DesktopContext,
  accountId: string,
  channelId: string,
  options: { url?: string; interactive?: boolean } = {},
): Promise<void> {
  const payload: JsonRow = { accountId, channelId };
  if (options.url !== undefined) payload.url = options.url;
  if (options.interactive === true) payload.interactive = true;
  try {
    await ctx.desktop.host.invoke("scrape.openConsole", payload);
  } catch (error) {
    throw badRequest(errorText(error));
  }
}

/** Rust `surface_scrape_webview`：把隐藏窗口显示出来供用户登录/处理。 */
async function surfaceConsole(ctx: DesktopContext, accountId: string): Promise<void> {
  try {
    await ctx.desktop.host.invoke("scrape.openConsole", { accountId, interactive: true });
  } catch {
    // 窗口已被用户关闭时无法展示；探���结果仍然返回给前端。
  }
}

/** Rust `current_scrape_page_url`：通过宿主 probeLogin 取当前页面 URL。 */
async function currentPageUrl(ctx: DesktopContext, accountId: string): Promise<string | null> {
  try {
    const response = await ctx.desktop.host.invoke<{ url?: unknown }>("scrape.probeLogin", {
      accountId,
    });
    const url = isPlainObject(response) ? response.url : undefined;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

// ─── 登录态探测（Rust probe_scrape_login） ──────────────────────────────────

interface ProbeContext {
  channelId: string;
  mode: ScrapeMode;
}

async function probeLoginStatus(
  ctx: DesktopContext,
  accountId: string,
  probe: ProbeContext,
  interactive: boolean,
): Promise<ScrapeLoginStatus> {
  const { channelId, mode } = probe;
  if (interactive) {
    // 人工刷新所有权必须在任何导航前声明：后台同步看到标记后跳过该账号。
    scrapeSessions.setInteractiveSessionActive(accountId, true);
    scrapeSessions.setInteractionRequired(accountId, true);
  } else if (scrapeSessions.isInteractionRequired(accountId)) {
    return {
      is_logged_in: false,
      channel_id: channelId,
      account_hint: null,
      probe_state: "login_required",
      message: "账号正在等待控制台登录或人工处理，本轮自动同步已跳过。",
    };
  }

  // Rust probe 的语义是「清缓冲 → 重新导航 → 等待业务响应」：ensure_scrape_console
  // 只建窗口（navigate_on_create=false），各阶段由 `window.navigate(phase_url)` 强制刷新。
  // Electron 宿主为保护 SSO 会在「首次阶段 URL 与当前页面相同」时跳过导航，那样
  // CDP 会错过已经发过的请求。命中这个分支时重建窗口（登录态在 partition 里，不丢），
  // 让第一阶段真正重新加载。
  const firstPhaseUrl = scrapePhases(mode)[0] ?? "";
  if (scrapeSessions.get(accountId) !== undefined && firstPhaseUrl !== "") {
    const current = await currentPageUrl(ctx, accountId);
    if (current === firstPhaseUrl) await destroyConsole(ctx, accountId);
  }

  // 窗口存在但未导航（Rust ensure_scrape_console(navigate_on_create=false)）。
  await openConsoleWindow(ctx, accountId, channelId);
  const session = scrapeSessions.open(accountId, channelId, mode);
  scrapeSessions.resetCapture(accountId);

  const { anyPhaseOk, lastError } = await capturePhases(
    ctx,
    session,
    channelId,
    mode,
    PROBE_PHASE_TIMEOUT_MS,
  );
  if (anyPhaseOk) scrapeSessions.markNativeReady(accountId);

  const pageUrl = (await currentPageUrl(ctx, accountId)) ?? "";
  session.pageUrl = pageUrl === "" ? null : pageUrl;
  const slots = sessionSlots(session, mode);
  const captured = aggregateComplete(slots, mode);
  // «监听已就绪» 与 Rust 同义：拦截器 ACK、宿主 CDP 监听生效、或已收到任意槽位，
  // 三者任一成立都不能再判定为「监听初始化失败」。未捕获目标响应 ≠ 未登录。
  const ready =
    scrapeSessions.get(accountId)?.ready !== null ||
    (scrapeSessions.get(accountId)?.nativeReady === true && anyPhaseOk) ||
    slots.size > 0;

  let probeState: ScrapeLoginStatus["probe_state"];
  if (captured) probeState = "captured";
  else if (pageUrl !== "" && isExplicitLoginUrl(mode, channelId, pageUrl)) probeState = "login_required";
  else if (ready) probeState = "console_action_required";
  else probeState = "capture_timeout";

  if (probeState === "login_required" || probeState === "console_action_required") {
    scrapeSessions.setInteractionRequired(accountId, true);
  }

  const missing = missingRequiredSlots(slots, mode.requiredSlots);
  const missingHint =
    missing.length === 0 ? "" : `（缺少：${missing.join(", ")}）${rawResponseSummary(session, mode)}`;
  if (
    lastError !== null &&
    (probeState === "console_action_required" || probeState === "capture_timeout")
  ) {
    // 诊断字段只进日志，不改写 Rust 的判定文案（前端依赖文案区分三种状态）。
    logFromFrontend(ctx, "warn", `控制台抓取阶段失败：${lastError}`, { accountId });
  }

  const message = ((): string | null => {
    switch (probeState) {
      case "captured":
        return null;
      case "login_required":
        return interactive
          ? "检测到控制台登录页，请在弹出的窗口中完成登录。"
          : "控制台登录状态已失效，本轮自动同步已跳过。请手动刷新并重新登录。";
      case "console_action_required":
        return interactive
          ? `未捕获到完整套餐接口响应${missingHint}，已打开控制台窗口。请在窗口中完成登录或等待页面加载后，再重新抓取。`
          : `未捕获到完整套餐接口响应${missingHint}，本轮自动同步已跳过。请手动刷新检查控制台。`;
      case "capture_timeout":
        return "控制台页面监听初始化失败，请重新抓取。";
    }
  })();

  if (interactive && (probeState === "login_required" || probeState === "console_action_required")) {
    await surfaceConsole(ctx, accountId);
  }

  return {
    is_logged_in: probeState === "captured",
    channel_id: channelId,
    account_hint: null,
    probe_state: probeState,
    message,
  };
}

/**
 * 会话当前可见的槽位集合：页面 IPC 缓冲（`pending`）与宿主 runPlan 逐阶段结果
 * (`slots`) 的并集。两边都按同一套槽位引擎校验/合并，直接并按槽位去重。
 */
function sessionSlots(session: ScrapeSession, mode: ScrapeMode): Map<string, string> {
  const slots = collectSlots(session.pending, mode);
  for (const [slot, body] of session.slots) {
    if (slots.has(slot)) continue;
    if (!slotSatisfied(mode, slot, body)) continue;
    slots.set(slot, body);
  }
  return slots;
}

/** Rust `missing_hint` 的 raw_summary 部分：把缓冲里已捕获响应的槽位+URL 拼出来。 */
function rawResponseSummary(session: ScrapeSession, mode: ScrapeMode): string {
  const parts = session.pending.map(
    ([url]) => `${classifySlot(mode, url)}@${url}`,
  );
  return parts.length === 0 ? "" : `（已捕获原始响应：${parts.join("；")}）`;
}

// ─── Extractor 执行 ─────────────────────────────────────────────────────────

const EVALUATE_UNAVAILABLE = /未实现的桌面宿主 channel|not implemented|unknown channel/i;

interface ExtractorInput {
  bundle: JsonRow;
  source: string;
  credential: JsonRow | null;
}

/**
 * 在页面里执行 extractor：优先宿主 `scrape.evaluate`（不导航、复用已捕获 bundle）；
 * 宿主未实现该 channel 时降级为再跑一次整段 plan 并在页面内提取（多一次导航）。
 */
async function evaluateExtractor(
  ctx: DesktopContext,
  accountId: string,
  channelId: string,
  mode: ScrapeMode,
  input: ExtractorInput,
): Promise<unknown> {
  try {
    const response = await ctx.desktop.host.invoke<{ result?: unknown }>("scrape.evaluate", {
      accountId,
      source: input.source,
      bundle: input.bundle,
      credential: input.credential,
      timeoutMs: EXTRACTOR_TIMEOUT_MS,
    });
    return isPlainObject(response) ? response.result : response;
  } catch (error) {
    const message = errorText(error);
    if (!EVALUATE_UNAVAILABLE.test(message)) {
      throw badRequest(`extractor 执行失败：${message}`);
    }
  }

  // 降级路径：宿主只能「导航 + 捕获 + 提取」一次完成。
  const phases = scrapePhases(mode);
  const plan: ScrapePlan = {
    consoleUrl: phases[0],
    interceptorJs: mode.interceptorJs === "" ? undefined : mode.interceptorJs,
    extractorJs: mode.extractorJs,
    slotRules: slotRulesForMode(channelId, mode),
    // 只让最后一个阶段等待本阶段槽位；前面阶段「有任意匹配响应」即可推进，
    // 这样多阶段 bundle 能在同一次 plan 内累积。
    requiredSlots: requiredSlotsForPhase(mode, phases.length - 1, phases.length),
    aggregate: true,
    credential: input.credential,
    timeoutMs: DEFAULT_PLAN_TIMEOUT_MS,
  };
  if (phases.length > 1) plan.consoleUrlSecondary = phases[1];
  if (phases.length > 2) plan.consoleUrlTertiary = phases[2];
  if (plan.requiredSlots !== undefined && plan.requiredSlots.length === 0) {
    delete plan.requiredSlots;
  }
  const outcome = await runPlan(ctx, accountId, plan);
  if (!outcome.ok) throw badRequest(outcome.error ?? "extractor 执行失败");
  // 宿主把 extractor 返回值放在 result；若返回的是槽位对象（未执行 extractor），报错而不是伪造。
  return outcome.slots;
}

// ─── scrape_balance 主流程 ──────────────────────────────────────────────────

/** Rust `core::qwen_platform::auto_sync_account`：已登录千问平台时优先走 HTTP 同步。 */
async function tryQwenPlatformSync(
  ctx: DesktopContext,
  account: JsonRow,
): Promise<ScrapeBalanceResult | null> {
  if (accountFieldString(account, "channel_id") !== "qwen") return null;
  if (platformAccountKind(account) === null) return null;
  const accountId = accountFieldString(account, "id");
  const resolution = resolveAccountCredentials(ctx.catalogDir, accountId);
  if (resolution.state !== "ok") return null;
  if (isCredentialsExpired(resolution.credentials)) return null;
  try {
    const outcome = await syncQwenPlatformAccount(ctx, accountId);
    return {
      balance: outcome.balance,
      currency: outcome.currency,
      plan_name: null,
      token_total: null,
      token_used: null,
      token_remaining: null,
      token_pack_expire_at: null,
      token_packs: null,
      raw_scraped_json: outcome.rawScrapedJson,
      source: "qwen_platform",
      synced_at: outcome.syncedAt,
    };
  } catch (error) {
    // 平台 HTTP 失败静默回退控制台抓取（与 Rust 一致）。
    void error;
    return null;
  }
}

async function scrapeBalanceImpl(
  ctx: DesktopContext,
  accountId: string,
  interactive: boolean,
): Promise<ScrapeBalanceResult> {
  if (!interactive && scrapeSessions.isInteractionRequired(accountId)) {
    throw badRequest("账号正在等待控制台登录或人工处理，本轮自动同步已跳过");
  }

  const account = findAccount(ctx, accountId);

  // 0. 千问 API 按量付费账号已登录千问平台时优先走官方 HTTP 接口，完全不创建窗口。
  const platformResult = await tryQwenPlatformSync(ctx, account);
  if (platformResult !== null) return platformResult;

  // 1. 解析抓取模式 + 派生账号凭据指纹（只传指纹，不传明文 Key）。
  const { channelId, mode } = requireMode(ctx, account);
  const credential = credentialKeyContext(accountFieldString(account, "api_key"));

  // 2. 前端通常已跑过 probe_scrape_login；直连调用时在这里补一次探测。
  let session = scrapeSessions.get(accountId);
  let captured = session !== undefined && aggregateComplete(sessionSlots(session, mode), mode);
  if (!captured) {
    const status = await probeLoginStatus(ctx, accountId, { channelId, mode }, interactive);
    if (status.probe_state === "login_required") {
      throw badRequest(
        interactive
          ? "请先登录官方控制台（已弹出登录窗口）"
          : "控制台登录状态已失效，请手动刷新并重新登录",
      );
    }
    if (status.probe_state !== "captured") {
      throw badRequest(status.message ?? "未捕获到控制台业务响应，请重试");
    }
    session = scrapeSessions.get(accountId);
    captured = true;
  }
  if (session === undefined) throw badRequest("抓取窗口不存在，请先打开控制台");

  // 3. 复用 probe 阶段捕获的同一批响应，不再二次刷新页面。
  const slots = sessionSlots(session, mode);
  if (!aggregateComplete(slots, mode)) {
    throw badRequest("未收到完整的控制台业务响应，请重试");
  }
  scrapeSessions.resetCapture(accountId);

  // 4. extractor 输入：聚合模式传 bundle，单响应模式传唯一目标槽位原始响应。
  const targetSlot = singleResponseTargetSlot(mode);
  const bundle: JsonRow = mode.aggregate
    ? buildAggregateBundle(slots)
    : { [targetSlot]: slots.get(targetSlot) ?? "" };
  if (!mode.aggregate && !slots.has(targetSlot)) {
    throw badRequest("未收到完整的控制台业务响应，请重试");
  }
  const source = buildExtractorSource(mode.extractorJs, mode.aggregate, targetSlot);
  const rawResult = await evaluateExtractor(
    ctx,
    accountId,
    channelId,
    mode,
    { bundle, source, credential },
  );

  // 5. 解析 extractor 输出与槽位稳定字段。
  const parsed = parseExtractorOutput(rawResult);
  const extracted = readExtractedBalance(parsed);
  const tokenPacks = normalizeScrapeTokenPacks(channelId, slots, extracted.token_packs);
  const now = new Date().toISOString();
  const rawScrapedJson = mode.aggregate
    ? JSON.stringify(buildAggregateBundle(slots))
    : (slots.get(targetSlot) ?? null);

  // 6. 写余额快照（AccountBalanceSnapshot 形状：snake_case，source="scrape"）。
  const snapshot: JsonRow = {
    id: `balance-${accountId}-${randomUUID()}`,
    account_id: accountId,
    balance: extracted.balance,
    currency: extracted.currency,
    token_pack_total: extracted.token_total,
    token_pack_used: extracted.token_used,
    token_pack_remaining: extracted.token_remaining,
    token_pack_expire_at: extracted.token_expire_at,
    token_packs: tokenPacks,
    raw_scraped_json: rawScrapedJson,
    source: "scrape",
    synced_at: now,
    remark: "控制台抓取",
    created_at: now,
    updated_at: now,
  };
  try {
    ctx.storage.withDatabase((db) => saveBalanceSnapshot(db, snapshot));
  } catch (error) {
    throw badRequest(`保存余额快照失败: ${errorText(error)}`);
  }

  // 7. 完整抓取成功后解除人工接管标记并关闭窗口（登录态在 partition 中）。
  if (interactive) {
    scrapeSessions.setInteractionRequired(accountId, false);
    scrapeSessions.setInteractiveSessionActive(accountId, false);
  }
  await destroyConsole(ctx, accountId);

  return {
    balance: extracted.balance,
    currency: extracted.currency,
    plan_name: extracted.plan_name,
    token_total: extracted.token_total,
    token_used: extracted.token_used,
    token_remaining: extracted.token_remaining,
    token_pack_expire_at: extracted.token_expire_at,
    token_packs: tokenPacks,
    raw_scraped_json: rawScrapedJson,
    source: "scrape",
    synced_at: now,
  };
}

// ─── sync_scrape_balances 编排（Rust channel_resource_sync_method） ──────────

type ChannelResourceSyncMethod = "official_api" | "console_scrape";

const OFFICIAL_BALANCE_CHANNELS: ReadonlySet<string> = new Set([
  "deepseek",
  "kimi",
  "openrouter",
  "vibetoken",
]);

/** Rust `channel_resource_sync_method`（官方余额 API / 控制台抓取 / 不参与）。 */
function channelResourceSyncMethod(
  ctx: DesktopContext,
  account: JsonRow,
): ChannelResourceSyncMethod | null {
  if (account.enabled !== true) return null;
  const channelId = accountFieldString(account, "channel_id");
  // Rust `channel_resource_sync_method` 读的是 ChannelsConfig::presets（即
  // config.json 的 channels[]），不是 SQLite 里的运行时预设快照。
  const supportsOfficialBalance =
    presetSupportsBalanceQuery(ctx, channelId) &&
    OFFICIAL_BALANCE_CHANNELS.has(channelId) &&
    effectiveOpenaiBaseUrl(account) === null;
  if (supportsOfficialBalance) return "official_api";
  if (account.resource_sync_mode !== "auto") return null;
  const mode = resolveScrapeMode(
    ctx,
    channelId,
    accountResourceMode(account),
    accountFieldString(account, "name"),
  );
  return mode === null ? null : "console_scrape";
}

function syncMethodLabel(method: ChannelResourceSyncMethod): string {
  return method === "official_api" ? "官方余额 API" : "官方控制台";
}

/** Rust `channel_resource_sync_completion_status`。 */
function completionStatus(failed: number, skipped: number): string {
  return failed > 0 || skipped > 0 ? "succeeded_with_warnings" : "succeeded";
}

/** 进程内互斥（Rust `JobRuntime::try_acquire_definition` 的 channel-resource-sync）。 */
let channelResourceSyncRunning = false;

/** 测试用：重置互斥标记。 */
export function resetChannelResourceSyncForTests(): void {
  channelResourceSyncRunning = false;
}

function accountLabel(account: JsonRow): string {
  const accountId = accountFieldString(account, "id");
  const suffix = accountId.includes("-") ? (accountId.split("-").pop() as string) : accountId;
  const accountName = accountFieldString(account, "name");
  const channelId = accountFieldString(account, "channel_id");
  return `${channelId} · ${accountName} · ${suffix}`;
}

async function syncScrapeBalancesImpl(
  ctx: DesktopContext,
  triggerSource: string,
): Promise<ScrapeBalanceSyncResult> {
  const snapshot = ctx.runtimeConfig.snapshot();
  const accounts = Array.isArray(snapshot.accounts) ? (snapshot.accounts as JsonRow[]) : [];
  const targets = accounts
    .map((account) => ({ account, method: channelResourceSyncMethod(ctx, account) }))
    .filter(
      (entry): entry is { account: JsonRow; method: ChannelResourceSyncMethod } =>
        entry.method !== null,
    );

  if (targets.length === 0) {
    return {
      started: false,
      jobId: null,
      accounts: 0,
      synced: 0,
      failed: 0,
      message: "没有可自动同步的渠道资源账号",
    };
  }
  if (channelResourceSyncRunning) {
    return {
      started: false,
      jobId: null,
      accounts: targets.length,
      synced: 0,
      failed: 0,
      message: "已有渠道资源自动同步正在运行",
    };
  }

  channelResourceSyncRunning = true;
  const jobId = randomUUID();
  const startedAt = Date.now();
  try {
    try {
      ctx.storage.withDatabase((db) => {
        createJob(db, {
          id: jobId,
          jobType: "channel-resource-sync",
          title: "渠道资源自动同步",
          stage: "同步账号资源",
          trigger: triggerSource,
          total: targets.length,
          firstEventMessage: `开始同步 ${targets.length} 个启用自动同步的渠道账号`,
          eventId: randomUUID(),
        });
      });
    } catch (error) {
      throw badRequest(`创建渠道资源同步任务失败：${errorText(error)}`);
    }

    // 同步前回收历史遗留会话（不参与本轮，但会占用抓取窗口额度）。
    await reclaimStaleSessions(ctx, "");

    let synced = 0;
    let failed = 0;
    let skipped = 0;
    for (let index = 0; index < targets.length; index += 1) {
      const { account, method } = targets[index] as {
        account: JsonRow;
        method: ChannelResourceSyncMethod;
      };
      const accountId = accountFieldString(account, "id");
      const label = accountLabel(account);

      if (method === "console_scrape" && scrapeSessions.isInteractionRequired(accountId)) {
        skipped += 1;
        addJobEventSafely(ctx, {
          jobId,
          level: "warning",
          stage: "跳过账号资源同步",
          message: `${label} 正在等待登录或人工处理，本轮已跳过`,
        });
        updateProgressSafely(ctx, jobId, index + 1, targets.length);
        continue;
      }

      let syncError: string | null = null;
      if (method === "official_api") {
        try {
          const result = await queryBalance(ctx, accountId);
          if (result.error !== null) syncError = result.error;
          else if (!result.is_available) syncError = "官方余额接口当前不可用";
        } catch (error) {
          syncError = errorText(error);
        }
      } else {
        try {
          await scrapeBalanceImpl(ctx, accountId, false);
        } catch (error) {
          syncError = error instanceof CommandError ? error.message : errorText(error);
        }
        // 后台轮次逐账号串行：无论成功/登录失效/超时都在切换账号前关闭窗口，
        // 人工接管中的账号除外（Rust scrape_interactive_session_active）。
        if (!scrapeSessions.isInteractiveSessionActive(accountId)) {
          await destroyConsole(ctx, accountId);
        }
      }

      if (syncError === null) {
        synced += 1;
        addJobEventSafely(ctx, {
          jobId,
          level: "info",
          stage: "同步账号资源",
          message: `${label} 通过${syncMethodLabel(method)}同步成功`,
        });
      } else {
        failed += 1;
        addJobEventSafely(ctx, {
          jobId,
          level: "warning",
          stage: "同步账号资源",
          message: `${label} 通过${syncMethodLabel(method)}同步失败：${syncError}`,
        });
      }
      updateProgressSafely(ctx, jobId, index + 1, targets.length);
    }

    const durationMs = Date.now() - startedAt;
    const officialApiAccounts = targets.filter((entry) => entry.method === "official_api").length;
    const summary = JSON.stringify({
      accounts: targets.length,
      officialApiAccounts,
      consoleAccounts: targets.length - officialApiAccounts,
      syncedAccounts: synced,
      failedAccounts: failed,
      skippedAccounts: skipped,
      durationMs,
    });
    const message = `渠道资源同步完成：成功 ${synced} 个，失败 ${failed} 个，跳过 ${skipped} 个`;
    try {
      ctx.storage.withDatabase((db) => {
        finishJob(db, {
          jobId,
          status: completionStatus(failed, skipped),
          summaryJson: summary,
          doneMessage: message,
          eventId: randomUUID(),
        });
      });
    } catch (error) {
      throw badRequest(`完成渠道资源同步任务失败：${errorText(error)}`);
    }

    return {
      started: true,
      jobId,
      accounts: targets.length,
      synced,
      failed,
      message,
    };
  } finally {
    channelResourceSyncRunning = false;
  }
}

function addJobEventSafely(
  ctx: DesktopContext,
  input: { jobId: string; level: string; stage: string; message: string },
): void {
  try {
    ctx.storage.withDatabase((db) => {
      addJobEvent(db, { ...input, eventId: randomUUID() });
    });
  } catch {
    // 任务日志是诊断信息，写入失败不能中断同步（与 Rust `let _ =` 语义一致）。
  }
}

function updateProgressSafely(
  ctx: DesktopContext,
  jobId: string,
  current: number,
  total: number,
): void {
  try {
    ctx.storage.withDatabase((db) => updateJobProgress(db, jobId, current, total));
  } catch {
    // 同上：进度日志失败不影响同步结果。
  }
}

// ─── 页面回调入口（handle_*） ───────────────────────────────────────────────

/**
 * 解析页面回调归属的账号。
 *
 * Rust 从 webview label（`scrape-<accountId>`）推导，页面无法伪造。Electron 的
 * CDP 路径不回传 IPC，因此这里按顺序：
 * 1. 显式 `accountId`（宿主若转发页面 IPC，必须把它补进 payload）；
 * 2. 当前唯一活跃抓取会话（单窗口下等价）；
 * 3. 都不满足 → 明确报错，绝不猜测。
 */
function resolveCallbackAccount(
  accountId: string | null,
  forbiddenMessage: string,
): string {
  if (accountId !== null && accountId !== "") {
    if (scrapeSessions.get(accountId) !== undefined) return accountId;
    throw badRequest(forbiddenMessage);
  }
  const only = scrapeSessions.only();
  if (only !== undefined) return only.accountId;
  throw badRequest(forbiddenMessage);
}

function callbackAccount(
  ctx: DesktopContext,
  accountId: string,
): JsonRow {
  const snapshot = ctx.runtimeConfig.snapshot();
  const accounts = Array.isArray(snapshot.accounts) ? (snapshot.accounts as JsonRow[]) : [];
  const account = accounts.find((item) => item?.id === accountId);
  if (account === undefined) throw badRequest("抓取窗口对应账号不存在");
  return account;
}

// ─── 命令注册 ───────────────────────────────────────────────────────────────

export const handlers: DesktopHandlerMap = {
  open_scrape_console: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const accountId = argString(args, "accountId");
    const account = findAccount(ctx, accountId);
    const { channelId, mode } = requireMode(ctx, account);

    // 已存在且窗口仍注册时复用（Rust 会校验 Tauri 中的窗口仍存活）。
    // 人工接管标记只由 probe_scrape_login 设置：单纯打开控制台不代表该账号
    // 等待人工处理，否则后台同步会永久跳过它。
    if (scrapeSessions.get(accountId) !== undefined) return null;

    // 创建前护栏顺序与 Rust 一致：先回收遗留窗口，再判断上限。
    await reclaimStaleSessions(ctx, accountId);
    const live = scrapeSessions.size();
    if (live >= SCRAPE_WEBVIEW_MAX_LIVE) {
      throw badRequest(
        `同时打开的控制台抓取窗口已达上限（${live}/${SCRAPE_WEBVIEW_MAX_LIVE}），请先关闭已打开的控制台窗口再重试`,
      );
    }

    try {
      await openConsoleWindow(ctx, accountId, channelId, { url: mode.consoleUrl, interactive: true });
    } catch (error) {
      throw badRequest(`加载控制台失败: ${errorText(error)}`);
    }
    scrapeSessions.open(accountId, channelId, mode);
    return null;
  },

  close_scrape_console: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const accountId = argString(args, "accountId");
    await destroyConsole(ctx, accountId);
    return null;
  },

  handle_intercepted_response: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const channelId = argString(args, "channelId");
    const url = argString(args, "url");
    const body = argString(args, "body");
    const explicitAccountId = argOptionalString(args, "accountId");
    const accountId = resolveCallbackAccount(
      explicitAccountId,
      "只允许抓取控制台窗口回传响应",
    );
    if (Buffer.byteLength(body, "utf8") > MAX_SCRAPED_RESPONSE_BYTES) {
      throw badRequest("抓取响应超过 8 MB，已拒绝写入缓冲");
    }
    const account = callbackAccount(ctx, accountId);
    if (accountFieldString(account, "channel_id") !== channelId) {
      throw badRequest("抓取响应渠道与账号不匹配");
    }
    const session = scrapeSessions.get(accountId);
    if (session === undefined) throw badRequest("抓取窗口未解析抓取模式");
    recordCapturedResponse(session.pending, url, body, session.mode);
    return null;
  },

  handle_scrape_interceptor_ready: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const channelId = argString(args, "channelId");
    const documentId = argString(args, "documentId");
    const pageUrl = argString(args, "pageUrl");
    const explicitAccountId = argOptionalString(args, "accountId");
    const accountId = resolveCallbackAccount(
      explicitAccountId,
      "只允许抓取控制台窗口报告监听状态",
    );
    if (
      documentId.length > MAX_DOCUMENT_ID_LENGTH ||
      pageUrl.length > MAX_INTERCEPTOR_PAGE_URL_LENGTH
    ) {
      throw badRequest("抓取监听状态参数过长");
    }
    const account = callbackAccount(ctx, accountId);
    if (accountFieldString(account, "channel_id") !== channelId) {
      throw badRequest("抓取监听渠道与账号不匹配");
    }
    scrapeSessions.setReady(accountId, { documentId, pageUrl });
    return null;
  },

  probe_scrape_login: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const accountId = argString(args, "accountId");
    const interactive = argOptionalBool(args, "interactive") ?? true;
    const account = findAccount(ctx, accountId);
    const { channelId, mode } = requireMode(ctx, account);
    return probeLoginStatus(ctx, accountId, { channelId, mode }, interactive);
  },

  scrape_balance: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const accountId = argString(args, "accountId");
    const interactive = argOptionalBool(args, "interactive") ?? true;
    return scrapeBalanceImpl(ctx, accountId, interactive);
  },

  sync_scrape_balances: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const triggerSource = argString(args, "triggerSource");
    return syncScrapeBalancesImpl(ctx, triggerSource);
  },

  open_external_url: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const url = argString(args, "url");
    const trimmed = url.trim();
    // Rust commands/qwen_platform.rs：只允许 http(s)，错误文案逐字一致。
    if (!(trimmed.startsWith("https://") || trimmed.startsWith("http://"))) {
      throw badRequest("只允许打开 http(s) 地址");
    }
    try {
      await ctx.desktop.host.invoke("platform.openExternal", { url: trimmed });
    } catch (error) {
      throw badRequest(`无法打开浏览器：${errorText(error)}`);
    }
    return null;
  },

  reload_custom_scrape_registry: (ctx) => {
    const registry = reloadCustomScrapeRegistry();
    // Web 侧 `list_custom_scrape_channels` 用 ctx.customScrapeChannels 做进程内缓存；
    // 重载后必须替换缓存，否则前端能力查询仍看到旧描述符（Rust 同样是全局注册表替换）。
    const infos: CustomScrapeChannelInfo[] = listCustomScrapeChannelInfos(registry);
    ctx.customScrapeChannels = infos as unknown as JsonRow[];
    return infos;
  },

  list_balance_snapshots: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const accountId = argString(args, "accountId");
    return ctx.storage.withDatabase((db) => listBalanceSnapshots(db, accountId));
  },
};

/** 诊断辅助：当前抓取会话快照（不暴露给前端命令面）。 */
export function scrapeSessionDiagnostics(): Array<{
  accountId: string;
  channelId: string;
  pending: number;
  slots: string[];
  ready: boolean;
  nativeReady: boolean;
  interactionRequired: boolean;
  interactiveSession: boolean;
}> {
  return scrapeSessions.list().map((session) => ({
    accountId: session.accountId,
    channelId: session.channelId,
    pending: session.pending.length,
    slots: [...session.slots.keys()],
    ready: session.ready !== null,
    nativeReady: session.nativeReady,
    interactionRequired: scrapeSessions.isInteractionRequired(session.accountId),
    interactiveSession: scrapeSessions.isInteractiveSessionActive(session.accountId),
  }));
}
