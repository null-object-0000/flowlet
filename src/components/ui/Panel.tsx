import React from "react";

type PanelProps = React.PropsWithChildren<{
  className?: string;
}>;

export function Panel({ className = "", children }: PanelProps) {
  return <section className={["panel", className].filter(Boolean).join(" ")}>{children}</section>;
}

export function DetailsPanel({ summary, children }: React.PropsWithChildren<{ summary: string }>) {
  return (
    <details className="panel advanced-panel">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

export function PanelHeader({ children }: React.PropsWithChildren) {
  return <div className="panel-title">{children}</div>;
}

export function Actions({ children }: React.PropsWithChildren) {
  return <div className="actions">{children}</div>;
}

export function EmptyState({ children }: React.PropsWithChildren) {
  return <div className="empty-state">{children}</div>;
}
