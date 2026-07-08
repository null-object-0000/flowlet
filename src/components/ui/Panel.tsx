import React from "react";
import { Box, Group, Paper, Stack } from "@mantine/core";

type PanelProps = React.PropsWithChildren<{
  className?: string;
}>;

export function Panel({ className = "", children }: PanelProps) {
  return (
    <Paper component="section" className={["panel", className].filter(Boolean).join(" ")} p="md">
      {children}
    </Paper>
  );
}

export function DetailsPanel({ summary, children }: React.PropsWithChildren<{ summary: string }>) {
  return (
    <Paper component="details" className="panel advanced-panel" p="md">
      <summary>{summary}</summary>
      <Stack gap="md">{children}</Stack>
    </Paper>
  );
}

export function PanelHeader({ children }: React.PropsWithChildren) {
  return <Group className="panel-title" justify="space-between" align="center" wrap="wrap">{children}</Group>;
}

export function Actions({ children }: React.PropsWithChildren) {
  return <Group className="actions" gap="xs" wrap="wrap">{children}</Group>;
}

export function EmptyState({ children }: React.PropsWithChildren) {
  return <Box className="empty-state">{children}</Box>;
}
