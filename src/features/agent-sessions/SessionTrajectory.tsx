import { Fragment, useMemo, useRef, useState, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { IconChevronDown, IconChevronRight, IconClose, IconSearch } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionInteractionEvent, AgentSessionNativeUsage } from "../../domains/agent-session/types";
import { formatCompactNumber } from "../../shared/formatters/number";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { Markdown } from "../../shared/ui/Markdown";
import styles from "./SessionTrajectory.module.css";

type RowKind = "system" | "user" | "context" | "message" | "tool" | "subtool" | "compacted";

export type TrajectoryRow = {
  id: string;
  index: number;
  turn: number | null;
  step: number | null;
  kind: RowKind;
  label: string;
  preview: string;
  event: AgentSessionInteractionEvent;
  outputEvent?: AgentSessionInteractionEvent;
};

export function deriveTrajectoryRows(events: AgentSessionInteractionEvent[]): TrajectoryRow[] {
  let inferredTurn = 0;
  const rows: TrajectoryRow[] = [];
  const calls = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === "user-message") inferredTurn += 1;
    const kind = trajectoryKind(event);
    if (kind === null || event.kind === "reasoning") return;
    // 官方语义：有 trace 且 turn 为 null → Between-turns（不推断）；
    // 无 trace（老格式）→ 按用户消息推断轮次；system/request 行沿用 trace 轮次，
    // 缺失时归入首个可见轮次（prologue 合并）。
    const hasTrace = event.trace != null;
    const turn = kind === "system"
      ? (event.trace?.turn ?? 0)
      : hasTrace
        ? (event.trace!.turn ?? null)
        : Math.max(inferredTurn, 1);
    const callId = event.trace?.callId;
    if (event.kind === "tool-result" && callId && calls.has(callId)) {
      const row = rows[calls.get(callId)!];
      if (row) {
        row.outputEvent = event;
        row.preview = toolPreview(row.event, event);
      }
      return;
    }
    const row: TrajectoryRow = {
      id: event.id,
      index: event.trace?.sequence ?? index + 1,
      turn,
      step: event.trace?.step ?? null,
      kind,
      label: trajectoryLabel(event, kind),
      preview: trajectoryPreview(event),
      event,
    };
    rows.push(row);
    if (event.kind === "tool-call" && callId) calls.set(callId, rows.length - 1);
  });
  // 官方把隐藏的 prologue（turn 0，request/system 行）合并进首个可见轮次。
  const firstTurn = rows.find((row) => row.turn != null && row.turn > 0)?.turn;
  if (firstTurn != null) {
    for (const row of rows) {
      if (row.turn === 0) row.turn = firstTurn;
    }
  }
  return rows;
}

function trajectoryKind(event: AgentSessionInteractionEvent): RowKind | null {
  if (event.kind === "request") return "system";
  if (event.kind === "user-message") return "user";
  if (event.kind === "context") return "context";
  if (event.kind === "assistant-message") return "message";
  if (event.kind === "tool-call" || event.kind === "tool-result") {
    return event.trace?.parentCallId ? "subtool" : "tool";
  }
  if (event.kind === "compacted") return "compacted";
  if (event.kind === "error") return "message";
  return null;
}

function trajectoryLabel(event: AgentSessionInteractionEvent, kind: RowKind) {
  if (kind === "system") return "SYSTEM";
  if (kind === "user") return "USER";
  if (kind === "context") return "CONTEXT";
  if (kind === "message") return event.kind === "error" ? "ERROR" : "ASSISTANT";
  if (kind === "compacted") return "COMPACTED";
  return event.title ?? (event.kind === "tool-result" ? "Result" : "Tool");
}

function trajectoryPreview(event: AgentSessionInteractionEvent) {
  if (event.kind === "request") return event.title ?? "Initial System Prompt";
  if (event.kind === "assistant-message" && !event.content) return "(tool call only)";
  const raw = event.content ?? event.trace?.input ?? event.trace?.output ?? "";
  return raw.replace(/\s+/g, " ").trim() || event.model || event.trace?.eventType || "—";
}

function toolPreview(call: AgentSessionInteractionEvent, result: AgentSessionInteractionEvent) {
  const input = trajectoryPreview(call);
  const output = trajectoryPreview(result);
  return output && output !== "—" ? `${input}  →  ${output}` : input;
}

export function SessionTrajectory({
  events,
  loading,
  error,
  onRetry,
}: {
  events: AgentSessionInteractionEvent[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { language, t } = useAppPreferences();
  const rows = useMemo(() => deriveTrajectoryRows(events), [events]);
  const [query, setQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(() => new Set());
  const [collapseCalls, setCollapseCalls] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(DEFAULT_PAGE_SIZE);
  const [range, setRange] = useState<[number, number] | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const turns = useMemo(() => [...new Set(rows.map((row) => row.turn).filter((turn): turn is number => turn != null && turn > 0))], [rows]);
  const betweenRows = rows.filter((row) => row.turn === null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter((row) => {
    if (row.turn != null && collapsedTurns.has(row.turn)) return false;
    if (collapseCalls && (row.kind === "tool" || row.kind === "subtool")) return false;
    if (range && (row.index < range[0] || row.index > range[1])) return false;
    if (!normalizedQuery) return true;
    return `${row.label} ${row.preview} ${row.outputEvent?.content ?? ""} ${row.event.model ?? ""} ${row.event.trace?.callId ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  // 分页：锚定尾部窗口，向上加载更早历史。
  const windowedRows = visibleRows.slice(Math.max(0, visibleRows.length - visibleLimit));
  const hasOlder = visibleRows.length > windowedRows.length;

  if (loading) return <TrajectoryState label={t("正在读取会话内容")} />;
  if (error) return <TrajectoryState label={t("会话加载失败：{message}", { message: error })} action={t("重试")} onAction={onRetry} />;
  if (rows.length === 0) return <TrajectoryState label={t("未找到可读取的会话内容")} />;

  const allTurnsCollapsed = turns.length > 0 && turns.every((turn) => collapsedTurns.has(turn));
  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("轨迹工具栏")}>
        <button
          type="button"
          className={styles.toolbarButton}
          aria-pressed={actualDuration}
          onClick={() => setActualDuration((value) => !value)}
        >
          <ClockIcon />{t("耗时")}
        </button>
        <button
          type="button"
          className={styles.toolbarButton}
          aria-pressed={allTurnsCollapsed}
          onClick={() => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turns))}
        >
          <span className={styles.foldIcon}>{allTurnsCollapsed ? "⊞" : "⊟"}</span>{t("轮次")}
        </button>
        <button
          type="button"
          className={styles.toolbarButton}
          aria-pressed={collapseCalls}
          onClick={() => setCollapseCalls((value) => !value)}
        >
          <span className={styles.foldIcon}>{collapseCalls ? "⊞" : "⊟"}</span>{t("调用")}
        </button>
        <label className={styles.search}>
          <IconSearch size="small" />
          <input
            type="search"
            value={query}
            placeholder={t("搜索轨迹")}
            aria-label={t("搜索轨迹")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      <TrajectoryTimeline
        rows={windowedRows}
        selectedId={selectedId}
        actualDuration={actualDuration}
        range={range}
        onSelect={setSelectedId}
        onRangeChange={setRange}
      />
      <div className={styles.split}>
        <div className={styles.tablePane}>
          <table className={styles.table}>
            <colgroup><col className={styles.eventColumn} /><col /></colgroup>
            <tbody>
              {hasOlder ? (
                <tr className={styles.loadOlderRow}>
                  <td colSpan={2}>
                    <button type="button" onClick={() => setVisibleLimit((value) => value + DEFAULT_PAGE_SIZE)}>
                      {t("加载更早")}
                    </button>
                  </td>
                </tr>
              ) : null}
              {betweenRows.length > 0 ? (
                <Fragment>
                  <tr className={styles.turnHeader}><td colSpan={2}><span className={styles.betweenLabel}>{t("Between turns")}</span></td></tr>
                  {betweenRows.map((row) => (
                    <TrajectoryTableRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      language={language}
                      onSelect={() => setSelectedId(row.id)}
                    />
                  ))}
                </Fragment>
              ) : null}
              {turns.map((turn) => {
                const turnRows = windowedRows.filter((row) => row.turn === turn);
                const collapsed = collapsedTurns.has(turn);
                if (collapsed) {
                  const steps = new Set(rows.filter((row) => row.turn === turn).map((row) => row.step).filter((step) => step != null)).size;
                  const tools = rows.filter((row) => row.turn === turn && (row.kind === "tool" || row.kind === "subtool")).length;
                  return (
                    <tr key={`turn-${turn}`} className={styles.turnSummary} onClick={() => toggleTurn(turn, setCollapsedTurns)}>
                      <td><IconChevronRight size="small" /> Turn {turn}</td>
                      <td>{turnSummaryText(steps, tools, t)}</td>
                    </tr>
                  );
                }
                if (turnRows.length === 0) return null;
                return (
                  <Fragment key={`turn-${turn}`}>
                    <tr className={styles.turnHeader}>
                      <td colSpan={2}>
                        <button type="button" className={styles.turnButton} onClick={() => toggleTurn(turn, setCollapsedTurns)}>
                          <IconChevronDown size="small" /><span>Turn {turn}</span>
                        </button>
                      </td>
                    </tr>
                    {turnRows.map((row) => (
                      <TrajectoryTableRow
                        key={row.id}
                        row={row}
                        selected={row.id === selectedId}
                        language={language}
                        onSelect={() => setSelectedId(row.id)}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {windowedRows.length === 0 ? <div className={styles.noMatches}>{t("没有匹配的轨迹事件")}</div> : null}
        </div>
        {selected ? <TrajectoryDetails row={selected} language={language} onClose={() => setSelectedId(null)} /> : null}
      </div>
    </div>
  );
}

const DEFAULT_PAGE_SIZE = 400;

function turnSummaryText(steps: number, tools: number, t: (key: string, params?: Record<string, string | number>) => string) {
  // 官方折叠文案：`{n} step(s) · {m} tool call(s)`
  return t("已折叠 {count} 条事件", { count: steps + tools }) + " · " + `${steps} step(s) · ${tools} tool call(s)`;
}

function toggleTurn(turn: number, update: Dispatch<SetStateAction<Set<number>>>) {
  update((current) => {
    const next = new Set(current);
    if (next.has(turn)) next.delete(turn);
    else next.add(turn);
    return next;
  });
}

function TrajectoryTableRow({
  row,
  selected,
  language,
  onSelect,
}: {
  row: TrajectoryRow;
  selected: boolean;
  language: "zh-CN" | "en-US";
  onSelect: () => void;
}) {
  const duration = row.outputEvent?.durationMs ?? row.event.durationMs;
  return (
    <tr data-kind={row.kind} data-selected={selected || undefined} tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }}>
      <td className={styles.eventCell}>
        <span className={styles.eventIndex}>#{row.index}</span>
        <span className={`${styles.kindTag} ${styles[`kind_${row.kind}`]}`}>{row.label}</span>
      </td>
      <td className={styles.contentCell}>
        <span className={styles.preview}>{row.preview}</span>
        {duration != null ? <span className={styles.rowDuration}>{formatDuration(duration)}</span> : null}
      </td>
    </tr>
  );
}

function TrajectoryTimeline({
  rows,
  selectedId,
  actualDuration,
  range,
  onSelect,
  onRangeChange,
}: {
  rows: TrajectoryRow[];
  selectedId: string | null;
  actualDuration: boolean;
  range: [number, number] | null;
  onSelect: (id: string) => void;
  onRangeChange: (value: [number, number] | null) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ anchor: number; last: number } | null>(null);
  const maxDuration = Math.max(...rows.map((row) => row.event.durationMs ?? 0), 1);
  const lane = (kind: RowKind) => kind === "message" ? 2 : kind === "tool" || kind === "subtool" ? 3 : 1;
  const indexAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rows.length === 0) return 0;
    return Math.min(rows.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * rows.length)));
  };
  const startDrag = (pointer: ReactPointerEvent<HTMLButtonElement>) => {
    const anchor = indexAt(pointer.clientX);
    dragRef.current = { anchor, last: anchor };
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const current = indexAt(event.clientX);
      if (current !== dragRef.current.last) {
        dragRef.current.last = current;
        const min = Math.min(dragRef.current.anchor, current);
        const max = Math.max(dragRef.current.anchor, current);
        onRangeChange(min === max ? null : [min, max]);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className={styles.timeline} aria-label="Trajectory timeline">
      <div className={styles.timelineLabels}><span>Input</span><span>Model</span><span>Tools</span></div>
      <div className={styles.timelineScroll}>
        <div
          ref={railRef}
          className={styles.timelineRail}
          style={{ "--trajectory-count": Math.max(rows.length, 1) } as CSSProperties}
          onContextMenu={(event) => { event.preventDefault(); onRangeChange(null); }}
          onDoubleClick={() => onRangeChange(null)}
        >
          {rows.map((row, index) => {
            const duration = row.outputEvent?.durationMs ?? row.event.durationMs ?? 0;
            const scale = actualDuration ? Math.max(1, Math.min(4, (duration / maxDuration) * 4)) : 1;
            const inRange = range ? row.index >= range[0] && row.index <= range[1] : true;
            const stylesForBlock: CSSProperties = { gridColumn: index + 1, gridRow: lane(row.kind), "--duration-scale": scale } as CSSProperties;
            const ttft = row.outputEvent?.timeToFirstTokenMs ?? row.event.timeToFirstTokenMs;
            if (row.kind === "message" && ttft != null && duration > ttft) {
              (stylesForBlock as Record<string, string>)["--ttft-frac"] = `${Math.max(0.06, Math.min(0.94, ttft / duration))}`;
            }
            return (
              <button
                key={row.id}
                type="button"
                className={`${styles.timelineBlock} ${styles[`timeline_${row.kind}`]}`}
                data-selected={row.id === selectedId || undefined}
                data-timeline-in-range={inRange || undefined}
                style={stylesForBlock}
                title={`${row.label} · ${row.preview}`}
                onClick={() => onSelect(row.id)}
                onPointerDown={startDrag}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type DetailTab = "overview" | "input" | "output" | "timing" | "system" | "tools";

function TrajectoryDetails({ row, language, onClose }: { row: TrajectoryRow; language: "zh-CN" | "en-US"; onClose: () => void }) {
  const { t } = useAppPreferences();
  const [tab, setTab] = useState<DetailTab>("overview");
  const [width, setWidth] = useState(380);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const event = row.event;
  const outputEvent = row.outputEvent;
  const trace = event.trace;
  const tabs: Array<{ id: DetailTab; label: string; available: boolean }> = [
    { id: "overview", label: t("概览"), available: true },
    { id: "input", label: t("输入"), available: Boolean(trace?.input || (event.kind === "tool-call" && event.content)) },
    { id: "output", label: t("输出"), available: Boolean(outputEvent?.content || outputEvent?.trace?.output || trace?.output || event.kind === "assistant-message") },
    { id: "timing", label: t("耗时"), available: Boolean(event.timestamp || event.durationMs != null) },
    { id: "system", label: "System Prompt", available: Boolean(trace?.systemPrompt) },
    { id: "tools", label: "Tools", available: Boolean(trace?.tools) },
  ];
  const startResize = (pointer: ReactPointerEvent<HTMLButtonElement>) => {
    drag.current = { startX: pointer.clientX, startWidth: width };
    pointer.currentTarget.setPointerCapture(pointer.pointerId);
  };
  const resize = (pointer: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    setWidth(Math.min(520, Math.max(300, drag.current.startWidth + drag.current.startX - pointer.clientX)));
  };
  return (
    <aside className={styles.details} style={{ width }}>
      <button
        type="button"
        className={styles.resizeHandle}
        aria-label={t("调整详情宽度")}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={() => { drag.current = null; }}
      />
      <header className={styles.detailsHeader}>
        <div className={styles.detailsTitle}><i /><strong>{row.label}</strong><span>#{row.index}</span></div>
        <button type="button" className={styles.closeButton} aria-label={t("关闭")} onClick={onClose}><IconClose /></button>
      </header>
      <div className={styles.detailTabs} role="tablist">
        {tabs.filter((item) => item.available).map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>
      <div className={styles.detailBody}>
        {tab === "overview" ? (
          <>
            <dl className={styles.overview}>
              <DetailRow label="Status" value={outputEvent?.status ?? event.status ?? (event.kind === "error" ? "Error" : "Completed")} error={event.kind === "error"} />
              {row.turn != null && row.turn > 0 ? <DetailRow label="Turn" value={String(row.turn)} /> : row.turn === null ? <DetailRow label="Turn" value="Between turns" /> : null}
              {row.step ? <DetailRow label="Step" value={String(row.step)} /> : null}
              {trace?.provider ? <DetailRow label="Provider" value={trace.provider} /> : null}
              {event.model ? <DetailRow label="Model" value={event.model} /> : null}
              {trace?.callId ? <DetailRow label="Call ID" value={trace.callId} /> : null}
              <DetailRow label="Duration" value={formatDuration(outputEvent?.durationMs ?? event.durationMs)} />
            </dl>
            {event.usage ? <UsagePreview usage={event.usage} language={language} /> : null}
            {event.content ? <PreviewSection title={t("预览")}><EventContent event={event} /></PreviewSection> : null}
          </>
        ) : null}
        {tab === "input" ? <CodePayload value={trace?.input ?? event.content} /> : null}
        {tab === "output" ? <EventContent event={outputEvent ?? { ...event, content: trace?.output ?? event.content }} /> : null}
        {tab === "timing" ? (
          <dl className={styles.overview}>
            <DetailRow label="Timestamp" value={event.timestamp ? formatFullTimestamp(event.timestamp, language) : "—"} />
            <DetailRow label="Duration" value={formatDuration(event.durationMs)} />
            <DetailRow label="TTFT" value={formatDuration(event.timeToFirstTokenMs)} />
          </dl>
        ) : null}
        {tab === "system" ? <MarkdownPayload content={trace?.systemPrompt} /> : null}
        {tab === "tools" ? <CodePayload value={trace?.tools} /> : null}
      </div>
    </aside>
  );
}

function DetailRow({ label, value, error = false }: { label: string; value: string; error?: boolean }) {
  return <div><dt>{label}</dt><dd data-error={error || undefined} title={value}>{value}</dd></div>;
}

function UsagePreview({ usage, language }: { usage: AgentSessionNativeUsage; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  return (
    <PreviewSection title={t("用量")}>
      <dl className={styles.overview}>
        <DetailRow label="Input" value={formatCompactNumber(usage.inputTokens, language)} />
        <DetailRow label="Cache read" value={formatCompactNumber(usage.cachedInputTokens, language)} />
        <DetailRow label="Output" value={formatCompactNumber(usage.outputTokens, language)} />
        <DetailRow label="Reasoning" value={formatCompactNumber(usage.reasoningTokens, language)} />
      </dl>
    </PreviewSection>
  );
}

function PreviewSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.previewSection}><h4>{title}<IconChevronRight size="small" /></h4><div>{children}</div></section>;
}

function EventContent({ event }: { event: AgentSessionInteractionEvent }) {
  if (!event.content) return <p className={styles.noPayload}>No payload</p>;
  if (["user-message", "assistant-message", "reasoning", "context", "compacted"].includes(event.kind)) {
    return <MarkdownPayload content={event.content} />;
  }
  return <CodePayload value={event.content} />;
}

function MarkdownPayload({ content }: { content: string | null | undefined }) {
  if (!content) return <p className={styles.noPayload}>No payload</p>;
  return <Markdown content={content} density="compact" className={styles.markdownPayload} />;
}

function CodePayload({ value }: { value: string | null | undefined }) {
  if (!value) return <p className={styles.noPayload}>No payload</p>;
  let formatted = value;
  try { formatted = JSON.stringify(JSON.parse(value), null, 2); } catch { /* plain text */ }
  return <pre className={styles.payload}>{formatted}</pre>;
}

function TrajectoryState({ label, action, onAction }: { label: string; action?: string; onAction?: () => void }) {
  return <div className={styles.state}><span>{label}</span>{action ? <button type="button" onClick={onAction}>{action}</button> : null}</div>;
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "—";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function ClockIcon() {
  return <svg className={styles.clockIcon} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="5.25" /><path d="M8 4.75V8l2.25 1.5" /></svg>;
}
