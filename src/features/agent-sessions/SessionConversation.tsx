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

/** 把完整会话事件按「用户消息」边界切分为多次交互（每次 = 一条用户消息 + 后续输出）。 */
function splitInteractions(events: AgentSessionInteractionEvent[]): AgentSessionInteractionEvent[][] {
  const interactions: AgentSessionInteractionEvent[][] = [];
  for (const event of events) {
    if (event.kind === "user-message") {
      interactions.push([event]);
    } else if (interactions.length > 0) {
      interactions[interactions.length - 1].push(event);
    } else {
      // 会话可能从一段输出中间开始（如首条事件就是工具结果/续跑会话）：
      // 开一条没有用户消息的交互承接这些输出，避免把开头的会话内容整段丢掉。
      interactions.push([event]);
    }
  }
  return interactions;
}

/**
 * 完整会话对话视图：把会话时间线的全部事件按轮次渲染为用户消息气泡 + 助手回复 +
 * 折叠的思考/工具调用组。与「会话详情抽屉」的最近一轮渲染一致，但展示全部交互。
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
  const interactions = splitInteractions(events);
  if (interactions.length === 0) {
    return <div className={styles.empty}>{t("未找到可读取的会话内容")}</div>;
  }
  return (
    <div className={styles.conversation}>
      {truncated ? <div className={styles.truncated}>{t("会话较长，以下仅展示最近部分内容")}</div> : null}
      {interactions.map((interaction, index) => (
        <InteractionUnit key={interaction[0].id} events={interaction} language={language} index={index} />
      ))}
    </div>
  );
}

function InteractionUnit({
  events,
  language,
  index,
}: {
  events: AgentSessionInteractionEvent[];
  language: "zh-CN" | "en-US";
  index: number;
}) {
  const { t } = useAppPreferences();
  const turnEvent = events.find((event) => event.kind === "turn") ?? null;
  const nonTurnEvents = events.filter((event) => event.kind !== "turn");
  const userEventIndex = nonTurnEvents.findIndex((event) => event.kind === "user-message");
  const userEvent = userEventIndex >= 0 ? nonTurnEvents[userEventIndex] : null;
  const outputEvents = userEventIndex >= 0 ? nonTurnEvents.slice(userEventIndex + 1) : nonTurnEvents;
  const outputItems = groupInteractionEvents(outputEvents);
  const hasAssistantMessage = outputEvents.some((event) => event.kind === "assistant-message");
  return (
    <section className={styles.unit} aria-label={t("第 {n} 轮", { n: index + 1 })}>
      {index > 0 ? <div className={styles.unitDivider}>{t("第 {n} 轮", { n: index + 1 })}</div> : null}
      {userEvent ? (
        <article className={styles.userRow} aria-label={t("用户消息")}>
          {userEvent.content ? <pre className={styles.userBubble}>{userEvent.content}</pre> : null}
        </article>
      ) : null}
      {outputItems.length > 0 ? (
        <div className={styles.outputStream}>
          {outputItems.map((item) => item.kind === "event" ? (
            <InteractionOutputEvent key={item.event.id} event={item.event} language={language} />
          ) : (
            <InteractionProcessGroup key={item.id} events={item.events} language={language} />
          ))}
        </div>
      ) : null}
      {turnEvent?.status === "running" ? (
        <div className={styles.progress} role="status"><i />{t("正在处理")}</div>
      ) : null}
      {turnEvent?.status === "cancelled" && !hasAssistantMessage ? (
        <div className={styles.notice}>{t("本轮已中断，未生成回复")}</div>
      ) : null}
      {turnEvent?.status === "completed" && !hasAssistantMessage ? (
        <div className={styles.notice}>{t("本轮未生成可展示的回复")}</div>
      ) : null}
    </section>
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

function formatDuration(milliseconds: number, language: "zh-CN" | "en-US") {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds)} s`;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds / 60)} min`;
}

function formatCacheHitRate(usage: AgentSessionNativeUsage, language: "zh-CN" | "en-US") {
  const totalInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens;
  if (totalInput <= 0) return "—";
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(usage.cachedInputTokens / totalInput);
}
