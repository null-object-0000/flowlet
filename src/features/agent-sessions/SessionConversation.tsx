import { useMemo } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionInteractionEvent, AgentSessionNativeUsage } from "../../domains/agent-session/types";
import { formatCompactNumber } from "../../shared/formatters/number";
import { formatCostAmount, formatNativeCost } from "../../shared/formatters/cost";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { Markdown } from "../../shared/ui/Markdown";
import styles from "./SessionConversation.module.css";

export type InteractionDisplayItem =
  | { kind: "event"; event: AgentSessionInteractionEvent }
  | { kind: "process"; id: string; events: AgentSessionInteractionEvent[] };

/** 把一次交互里的输出事件分组：连续的思考/工具事件折叠为 process 组，其余单条展示。 */
export function groupInteractionEvents(events: AgentSessionInteractionEvent[]): InteractionDisplayItem[] {
  const items: InteractionDisplayItem[] = [];
  let processEvents: AgentSessionInteractionEvent[] = [];
  const flushProcess = () => {
    if (processEvents.length === 0) return;
    items.push({ kind: "process", id: `process:${processEvents[0].id}`, events: processEvents });
    processEvents = [];
  };
  for (const event of events) {
    if (isProcessEvent(event)) {
      processEvents.push(event);
    } else {
      flushProcess();
      items.push({ kind: "event", event });
    }
  }
  flushProcess();
  return items;
}

export function isProcessEvent(event: AgentSessionInteractionEvent) {
  return matchesInteractionKind(event.kind, ["reasoning", "tool-call", "tool-result"]);
}

function matchesInteractionKind(
  kind: AgentSessionInteractionEvent["kind"],
  candidates: AgentSessionInteractionEvent["kind"][],
) {
  return candidates.includes(kind);
}

/** 按轮次分组：与官方一致，轮次由 `turn` 事件开合（user/message 不切开轮次）。 */
type TurnUnitModel = {
  turn: number | null;
  status: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  events: AgentSessionInteractionEvent[];
};

function buildTurnGroups(events: AgentSessionInteractionEvent[]): TurnUnitModel[] {
  const groups: TurnUnitModel[] = [];
  for (const event of events) {
    if (event.kind === "turn") {
      groups.push({
        turn: event.trace?.turn ?? null,
        status: event.status,
        durationMs: event.durationMs,
        errorMessage: event.content,
        events: [],
      });
    } else {
      if (groups.length === 0) {
        groups.push({ turn: null, status: null, durationMs: null, errorMessage: null, events: [] });
      }
      groups[groups.length - 1].events.push(event);
    }
  }
  return groups;
}

type OutputItem =
  | { type: "think"; event: AgentSessionInteractionEvent }
  | { type: "message"; event: AgentSessionInteractionEvent }
  | { type: "retry"; event: AgentSessionInteractionEvent }
  | { type: "tools"; events: AgentSessionInteractionEvent[] };

function buildOutputItems(events: AgentSessionInteractionEvent[]): OutputItem[] {
  const items: OutputItem[] = [];
  let tools: AgentSessionInteractionEvent[] = [];
  const flush = () => {
    if (tools.length > 0) {
      items.push({ type: "tools", events: tools });
      tools = [];
    }
  };
  for (const event of events) {
    if (event.kind === "tool-call" || event.kind === "tool-result") {
      tools.push(event);
      continue;
    }
    flush();
    if (event.kind === "reasoning") items.push({ type: "think", event });
    else if (event.kind === "model-retry") items.push({ type: "retry", event });
    else if (event.kind === "assistant-message" || event.kind === "error") items.push({ type: "message", event });
  }
  flush();
  return items;
}

/**
 * 完整会话对话视图：按轮次渲染为用户消息气泡 + 上下文折叠行 + 助手回复（含 Think
 * 折叠行与工具/推理组）+ 压缩标记 + 轮次状态/尾部统计。与上游 `ui-conversation` 的
 * 节点语义对齐：turn/start 开轮、turn/end.reason 决定状态、非 user 来源投影为 context。
 */
export function SessionConversation({
  events,
  truncated,
  loading,
  error,
  language,
  onRetry,
}: {
  events: AgentSessionInteractionEvent[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  if (loading) {
    return (
      <div className={styles.loading} aria-label={t("正在读取会话内容")}>
        <span /><span /><span />
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.errorBox}>
        <span>{t("会话加载失败：{message}", { message: error })}</span>
        <button onClick={onRetry}>{t("重试")}</button>
      </div>
    );
  }
  const groups = useMemo(() => buildTurnGroups(events), [events]);
  if (groups.every((group) => group.events.length === 0)) {
    return <div className={styles.empty}>{t("未找到可读取的会话内容")}</div>;
  }
  return (
    <div className={styles.conversation}>
      {truncated ? <div className={styles.truncated}>{t("会话较长，以下仅展示最近部分内容")}</div> : null}
      {groups.map((model, index) => (
        <TurnUnit key={model.turn != null ? `turn-${model.turn}` : `prologue-${index}`} model={model} language={language} index={index} />
      ))}
    </div>
  );
}

function TurnUnit({
  model,
  language,
  index,
}: {
  model: TurnUnitModel;
  language: "zh-CN" | "en-US";
  index: number;
}) {
  const { t } = useAppPreferences();
  const users = model.events.filter((event) => event.kind === "user-message");
  const contexts = model.events.filter((event) => event.kind === "context");
  const compactions = model.events.filter((event) => event.kind === "compacted");
  const outputs = model.events.filter((event) =>
    event.kind !== "user-message" &&
    event.kind !== "context" &&
    event.kind !== "compacted" &&
    event.kind !== "request" &&
    event.kind !== "turn",
  );
  const outputItems = useMemo(() => buildOutputItems(outputs), [outputs]);
  const messages = outputs.filter((event) => event.kind === "assistant-message");
  const hasOutput = messages.length > 0;
  return (
    <section className={styles.unit} aria-label={t("第 {n} 轮", { n: index + 1 })}>
      {index > 0 ? <div className={styles.unitDivider}>{t("第 {n} 轮", { n: index + 1 })}</div> : null}
      {users.map((event) => (
        <article key={event.id} className={styles.userRow} aria-label={t("用户消息")}>
          {event.content ? <pre className={styles.userBubble}>{event.content}</pre> : null}
        </article>
      ))}
      {contexts.map((event) => <ContextDisclosure key={event.id} event={event} />)}
      {compactions.map((event) => <CompactionRow key={event.id} event={event} language={language} />)}
      {outputItems.length > 0 ? (
        <div className={styles.outputStream}>
          {outputItems.map((item, index) => item.type === "think" ? (
            <ThinkRow key={item.event.id} event={item.event} />
          ) : item.type === "retry" ? (
            <ModelRetryRow key={item.event.id} event={item.event} />
          ) : item.type === "message" ? (
            <InteractionOutputEvent key={item.event.id} event={item.event} language={language} />
          ) : (
            <InteractionProcessGroup key={`${item.events[0]?.id ?? index}:group`} events={item.events} language={language} />
          ))}
        </div>
      ) : null}
      <TurnStatusNotice model={model} hasOutput={hasOutput} />
      <TurnFooter model={model} messages={messages} language={language} />
    </section>
  );
}

/** 上下文注入折叠行（对齐官方 DisclosureRow）：默认收起，正文 141px 内滚动。
 *  来源 provenance：instructions → 「上下文注入」+ 消化的文件路径；recall →
 *  「跨会话召回」+ 生产者。 */
function ContextDisclosure({ event }: { event: AgentSessionInteractionEvent }) {
  const { t } = useAppPreferences();
  const trace = event.trace;
  const isRecall = trace?.sourceKind === "session-reference" || trace?.sourceForm === "recall";
  const label = isRecall ? t("跨会话召回") : t("上下文注入");
  const summary = firstLine(event.content);
  return (
    <details className={styles.contextRow} data-context-form={trace?.sourceForm ?? undefined}>
      <summary className={styles.contextHeader}>
        <i aria-hidden />
        <span>{label}</span>
        {trace?.producer ? <b className={styles.contextProducer}>{trace.producer}</b> : null}
        {summary ? <small>{summary}</small> : null}
      </summary>
      {event.content ? (
        <div className={styles.contextBody}>
          <Markdown content={event.content} density="compact" />
        </div>
      ) : null}
    </details>
  );
}

/** 模型重试行（对齐官方 model-retry）：稳定单行，展示次数/延迟/失败原因。 */
function ModelRetryRow({ event }: { event: AgentSessionInteractionEvent }) {
  return (
    <details className={styles.retryRow}>
      <summary className={styles.retryHeader}>
        <i aria-hidden />
        <span>{event.title ?? "Retry"}</span>
      </summary>
      {event.content ? <pre className={styles.retryBody}>{event.content}</pre> : null}
    </details>
  );
}

/** Think 折叠行（对齐官方）：默认收起，标题固定 "Think"，摘要取首行。 */
function ThinkRow({ event }: { event: AgentSessionInteractionEvent }) {
  const summary = firstLine(event.content);
  return (
    <details className={styles.thinkRow}>
      <summary className={styles.thinkHeader}>
        <span>Think</span>
        {summary ? <small>{summary}</small> : null}
      </summary>
      {event.content ? <div className={styles.thinkBody}>{event.content}</div> : null}
    </details>
  );
}

/** 压缩标记（compacted 事件）：默认收起，正文为压缩总结。 */
function CompactionRow({
  event,
  language,
}: {
  event: AgentSessionInteractionEvent;
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  return (
    <details className={styles.compactionRow}>
      <summary className={styles.compactionHeader}>
        <i aria-hidden />
        <span>{t("上下文已压缩")}</span>
        {event.durationMs != null ? <small>{t("耗时 {duration}", { duration: formatDuration(event.durationMs, language) })}</small> : null}
      </summary>
      {event.content ? (
        <div className={styles.compactionBody}>
          <Markdown content={event.content} density="compact" />
        </div>
      ) : null}
    </details>
  );
}

function TurnStatusNotice({ model, hasOutput }: { model: TurnUnitModel; hasOutput: boolean }) {
  const { t } = useAppPreferences();
  if (model.status === "running") {
    return (
      <div className={styles.progress} role="status"><i />{t("正在处理")}</div>
    );
  }
  if (model.status === "error") {
    return (
      <div className={styles.turnError} role="status">
        <b>{t("本轮运行失败")}</b>
        {model.errorMessage ? <span>{model.errorMessage}</span> : null}
      </div>
    );
  }
  if (model.status === "max-tokens") {
    return <div className={styles.turnMaxTokens} role="status">{t("已达到输出 token 上限")}</div>;
  }
  if (model.status === "cancelled") {
    return <div className={styles.notice}>{hasOutput ? t("已停止") : t("本轮已中断，未生成回复")}</div>;
  }
  if (model.status === "completed" && !hasOutput) {
    return <div className={styles.notice}>{t("本轮未生成可展示的回复")}</div>;
  }
  return null;
}

/** 已完成轮次的尾部统计：用时 + 首 token + 解码吞吐（对齐官方 turn-tail）。 */
function TurnFooter({
  model,
  messages,
  language,
}: {
  model: TurnUnitModel;
  messages: AgentSessionInteractionEvent[];
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  if (model.status !== "completed" || model.durationMs == null) return null;
  const firstMessage = messages.find((event) => event.timeToFirstTokenMs != null);
  let outputTokens = 0;
  let decodeMs = 0;
  for (const message of messages) {
    if (message.durationMs == null || message.timeToFirstTokenMs == null || !message.usage) continue;
    const tokens = message.usage.outputTokens ?? 0;
    const decode = Math.max(0, message.durationMs - message.timeToFirstTokenMs);
    if (tokens > 0 && decode > 0) {
      outputTokens += tokens;
      decodeMs += decode;
    }
  }
  return (
    <div className={styles.turnFooter}>
      <span>{t("耗时 {duration}", { duration: formatDuration(model.durationMs, language) })}</span>
      {firstMessage?.timeToFirstTokenMs != null ? (
        <span>{t("首 Token {duration}", { duration: formatDuration(firstMessage.timeToFirstTokenMs, language) })}</span>
      ) : null}
      {outputTokens > 0 && decodeMs > 0 ? <span>{formatTokensPerSecond(outputTokens, decodeMs)} tok/s</span> : null}
    </div>
  );
}

export function InteractionOutputEvent({
  event,
  language,
}: {
  event: AgentSessionInteractionEvent;
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  if (event.kind === "assistant-message") {
    return (
      <article className={styles.outputMessage} aria-label={t("助手回复")}>
        {event.content ? <Markdown content={event.content} /> : null}
        {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
      </article>
    );
  }
  if (event.kind === "error") {
    return (
      <article className={`${styles.outputMessage} ${styles.assistantError}`} aria-label={t("错误")}>
        {event.content ? <pre className={styles.errorContent}>{event.content}</pre> : null}
        {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
      </article>
    );
  }
  return null;
}

export function InteractionProcessGroup({
  events,
  language,
}: {
  events: AgentSessionInteractionEvent[];
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  const toolCalls = events.filter((event) => event.kind === "tool-call").length;
  const reasoning = events.filter((event) => event.kind === "reasoning").length;
  return (
    <details className={styles.processGroup}>
      <summary className={styles.processGroupHeader}>
        <span>{t("已处理 {count} 项", { count: events.length })}</span>
        <small>
          {[
            reasoning > 0 ? t("{count} 项思考", { count: reasoning }) : null,
            toolCalls > 0 ? t("{count} 次工具调用", { count: toolCalls }) : null,
          ].filter(Boolean).join(" · ")}
        </small>
      </summary>
      <div className={styles.processGroupBody}>
        {events.map((event) => (
          <ProcessEvent key={event.id} event={event} language={language} />
        ))}
      </div>
    </details>
  );
}

function ProcessEvent({ event, language }: { event: AgentSessionInteractionEvent; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const label = interactionEventLabel(event.kind, t);
  return (
    <article className={styles.processEvent}>
      <header>
        <span>{label}</span>
        <strong>{event.title ?? event.model ?? label}</strong>
        {event.timestamp ? <time>{formatTimestamp(event.timestamp, language)}</time> : null}
      </header>
      {event.content ? <ToolEventContent event={event} /> : null}
      <InteractionEventStatus event={event} language={language} />
      {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
    </article>
  );
}

function ToolEventContent({ event }: { event: AgentSessionInteractionEvent }) {
  const { t } = useAppPreferences();
  const parsed = parseToolPayload(event.content ?? "");
  const fallbackLabel = event.kind === "tool-result"
    ? t("执行结果")
    : toolInputLabel(event.title, t);
  if (!parsed) {
    return (
      <div className={styles.toolPayload}>
        <span>{fallbackLabel}</span>
        <pre>{event.content}</pre>
      </div>
    );
  }
  return (
    <div className={styles.toolPayloadList}>
      {parsed.map(({ key, value }) => (
        <div className={styles.toolPayload} key={key}>
          <span>{toolFieldLabel(key, fallbackLabel, t)}</span>
          <pre>{value}</pre>
        </div>
      ))}
    </div>
  );
}

function parseToolPayload(content: string): Array<{ key: string; value: string }> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    return Object.entries(parsed).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }));
  } catch {
    return null;
  }
}

function toolInputLabel(title: string | null, t: (key: string) => string) {
  if (title === "exec") return t("执行脚本");
  if (title === "exec_command" || title === "shell" || title === "bash") return t("命令");
  if (title === "apply_patch") return t("补丁内容");
  return t("调用参数");
}

function toolFieldLabel(key: string, fallback: string, t: (key: string) => string) {
  if (key === "cmd" || key === "command") return t("命令");
  if (key === "output") return t("输出");
  if (key === "workdir" || key === "cwd") return t("工作目录");
  if (key === "exit_code" || key === "exitCode") return t("退出码");
  if (key === "status") return t("状态");
  if (key === "input" || key === "arguments") return fallback;
  return key;
}

function InteractionEventStatus({ event, language }: { event: AgentSessionInteractionEvent; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  if (!event.status && event.durationMs == null && event.timeToFirstTokenMs == null) return null;
  return (
    <small className={styles.interactionStatus}>
      {[
        event.status ? t("状态：{status}", { status: interactionStatusLabel(event.status, t) }) : null,
        event.durationMs != null ? t("耗时 {duration}", { duration: formatDuration(event.durationMs, language) }) : null,
        event.timeToFirstTokenMs != null ? t("首 Token {duration}", { duration: formatDuration(event.timeToFirstTokenMs, language) }) : null,
      ].filter(Boolean).join(" · ")}
    </small>
  );
}

function InteractionEventUsage({ usage, language }: { usage: AgentSessionNativeUsage; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const items = [
    [t("总计"), usage.totalTokens],
    [t("输入"), usage.inputTokens],
    [t("输出"), usage.outputTokens],
    [t("缓存读取"), usage.cachedInputTokens],
    [t("缓存写入"), usage.cacheWriteInputTokens],
    [t("推理"), usage.reasoningTokens],
  ] as const;
  return (
    <div className={styles.eventUsage} aria-label={t("单次原生用量")}>
      {items.filter(([, value], index) => index === 0 || value > 0).map(([label, value]) => (
        <span key={label}>{label} {formatCompactNumber(value, language)}</span>
      ))}
      {usage.inputTokens > 0 ? <span>{t("缓存命中率")} {formatCacheHitRate(usage, language)}</span> : null}
      {usage.apiEquivalent?.amount != null ? <span>{t("API 等价")} {formatCostAmount(usage.apiEquivalent, 4)}</span> : null}
      {usage.cost != null ? <span>{t("原生实际费用")} {formatNativeCost(usage)}</span> : null}
    </div>
  );
}

function interactionEventLabel(kind: AgentSessionInteractionEvent["kind"], t: (key: string, params?: Record<string, string | number>) => string) {
  if (kind === "turn") return t("Agent 轮次");
  if (kind === "user-message") return t("用户消息");
  if (kind === "assistant-message") return t("助手回复");
  if (kind === "reasoning") return t("思考摘要");
  if (kind === "tool-call") return t("工具调用");
  if (kind === "tool-result") return t("工具结果");
  return t("错误");
}

function interactionStatusLabel(status: string, t: (key: string) => string) {
  if (status === "running") return t("运行中");
  if (status === "completed") return t("已完成");
  if (status === "cancelled") return t("已取消");
  return status;
}

function firstLine(content: string | null | undefined): string {
  if (!content) return "";
  return content.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function formatDuration(milliseconds: number, language: "zh-CN" | "en-US") {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds)} s`;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds / 60)} min`;
}

function formatTokensPerSecond(outputTokens: number, decodeMs: number) {
  const value = (outputTokens * 1_000) / decodeMs;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatCacheHitRate(usage: AgentSessionNativeUsage, language: "zh-CN" | "en-US") {
  const totalInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens;
  if (totalInput <= 0) return "—";
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(usage.cachedInputTokens / totalInput);
}