import { ProtocolType, protocolLabels } from "../../domain";

export function StatusPill({ running, children }: { running: boolean; children: React.ReactNode }) {
  return <span className={running ? "status running" : "status"}>{children}</span>;
}

export function ProtocolBadges({ protocols }: { protocols: ProtocolType[] }) {
  return (
    <div className="channel-protocols">
      {protocols.map((protocol) => (
        <span className="protocol-badge" key={protocol}>
          {protocolLabels[protocol]}
        </span>
      ))}
    </div>
  );
}
