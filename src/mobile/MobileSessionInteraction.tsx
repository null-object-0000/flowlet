import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SyncedAgentInteractionEvent } from "../domains/device-sync/types";
import { formatTimestamp } from "../shared/formatters/datetime";
import { Markdown } from "../shared/ui/Markdown";
import styles from "./MobileSessionInteraction.module.css";

type DisplayItem =
  | { kind: "event"; event: SyncedAgentInteractionEvent }
  | { kind: "process"; id: string; events: SyncedAgentInteractionEvent[] };

/**
 * 渲染同步快照携带的「最近一轮」完整事件流，供移动端在审批等待确认的会话前查看上下文。
 * 与桌面端会话详情保持一致：用户输入纯文本原样展示，助手输出 Markdown 渲染，
 * 思考/工具调用折叠为过程组，错误消息原样展示。
 */
export function MobileSessionInteraction({ events }: { events: SyncedAgentInteractionEvent[] }) {
  const { language, t } = useAppPreferences();
  const turnEvent = events.find((event) => event.kind === "turn") ?? null;
  const flow = events.filter((event) => event.kind !== "turn");
  const userEventIndex = flow.findIndex((event) => event.kind === "user-message");
  const userEvent = userEventIndex >= 0 ? flow[userEventIndex] : null;
  const outputEvents = userEventIndex >= 0 ? flow.slice(userEventIndex + 1) : flow;
  const items = groupInteractionEvents(outputEvents);
  const hasAssistantMessage = outputEvents.some((event) => event.kind === "assistant-message");

  return (
    <div className={styles.flow}>
      {userEvent?.content ? (
        <pre className={styles.userBubble} aria-label={t("用户消息")}>{userEvent.content}</pre>
      ) : null}
      {items.map((item) => item.kind === "event" ? (
        <OutputEvent key={item.event.id} event={item.event} />
      ) : (
        <ProcessGroup key={item.id} events={item.events} language={language} />
      ))}
      {turnEvent?.status === "cancelled" && !hasAssistantMessage ? (
        <div className={styles.notice}>{t("本轮已中断，未生成回复")}</div>
      ) : null}
      {turnEvent?.status === "completed" && !hasAssistantMessage ? (
        <div className={styles.notice}>{t("本轮未生成可展示的回复")}</div>
      ) : null}
    </div>
  );
}

function groupInteractionEvents(events: SyncedAgentInteractionEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let processEvents: SyncedAgentInteractionEvent[] = [];
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

function isProcessEvent(event: SyncedAgentInteractionEvent) {
  return event.kind === "reasoning" || event.kind === "tool-call" || event.kind === "tool-result";
}

function OutputEvent({ event }: { event: SyncedAgentInteractionEvent }) {
  const { t } = useAppPreferences();
  if (event.kind === "assistant-message") {
    return event.content ? (
      <div className={styles.assistant} aria-label={t("助手回复")}>
        <Markdown content={event.content} />
      </div>
    ) : null;
  }
  if (event.kind === "error") {
    return event.content ? <pre className={styles.error}>{event.content}</pre> : null;
  }
  return null;
}

function ProcessGroup({
  events,
  language,
}: {
  events: SyncedAgentInteractionEvent[];
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  const toolCalls = events.filter((event) => event.kind === "tool-call").length;
  const reasoning = events.filter((event) => event.kind === "reasoning").length;
  return (
    <details className={styles.processGroup}>
      <summary>
        <span>{t("已处理 {count} 项", { count: events.length })}</span>
        <small>
          {[
            reasoning > 0 ? t("{count} 项思考", { count: reasoning }) : null,
            toolCalls > 0 ? t("{count} 次工具调用", { count: toolCalls }) : null,
          ].filter(Boolean).join(" · ")}
        </small>
      </summary>
      <div className={styles.processBody}>
        {events.map((event) => (
          <article className={styles.processEvent} key={event.id}>
            <header>
              <span>{interactionEventLabel(event.kind, t)}</span>
              <strong>{event.title ?? event.model ?? interactionEventLabel(event.kind, t)}</strong>
              {event.timestamp ? <time>{formatTimestamp(event.timestamp, language)}</time> : null}
            </header>
            {event.content ? <pre>{event.content}</pre> : null}
          </article>
        ))}
      </div>
    </details>
  );
}

function interactionEventLabel(kind: string, t: (key: string) => string) {
  if (kind === "user-message") return t("用户消息");
  if (kind === "assistant-message") return t("助手回复");
  if (kind === "reasoning") return t("思考摘要");
  if (kind === "tool-call") return t("工具调用");
  if (kind === "tool-result") return t("工具结果");
  return t("错误");
}
