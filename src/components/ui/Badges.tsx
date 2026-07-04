import { ProtocolType, protocolLabels } from "../../domain";

export function StatusPill({ running, children }: { running: boolean; children: React.ReactNode }) {
  return <span className={running ? "status running" : "status"}>{children}</span>;
}

export function ProtocolBadges({ protocols }: { protocols: ProtocolType[] }) {
  const valid = protocols.filter((p): p is ProtocolType => p in protocolLabels);
  return (
    <div className="channel-protocols">
      {valid.map((protocol) => (
        <span className="protocol-badge" key={protocol}>
          {protocolLabels[protocol]}
        </span>
      ))}
    </div>
  );
}
