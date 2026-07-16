import React from "react";
import { Text } from "@mantine/core";
import { Panel, PanelHeader } from "./Panel";
import card from "./OverviewSectionCard.module.css";

type OverviewSectionCardProps = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  grow?: boolean;
  children: React.ReactNode;
};

export function OverviewSectionCard({ title, subtitle, actions, grow = false, children }: OverviewSectionCardProps) {
  return (
    <Panel className={grow ? `overview-section-card overview-section-card--grow` : "overview-section-card"}>
      <PanelHeader>
        <div>
          {title}
          {subtitle ? <Text size="sm" c="dimmed">{subtitle}</Text> : null}
        </div>
        {actions ? <div className={card.actionsWrap}>{actions}</div> : null}
      </PanelHeader>
      {children}
    </Panel>
  );
}
