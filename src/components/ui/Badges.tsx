import type React from "react";
import { Badge, Group } from "@mantine/core";
import { ProtocolType, protocolLabels } from "../../domain";

export function StatusPill({ running, children }: { running: boolean; children: React.ReactNode }) {
  return (
    <Badge className={running ? "status running" : "status"} color={running ? "green" : "gray"} variant="light" size="sm">
      {children}
    </Badge>
  );
}

export function ProtocolBadges({ protocols }: { protocols: ProtocolType[] }) {
  const valid = protocols.filter((p): p is ProtocolType => p in protocolLabels);
  return (
    <Group className="channel-protocols" gap={4} wrap="wrap">
      {valid.map((protocol) => (
        <Badge className="protocol-badge" key={protocol} color="blue" variant="light" size="xs">
          {protocolLabels[protocol]}
        </Badge>
      ))}
    </Group>
  );
}

