import { AgentSessionsView } from "../desktop/AgentSessionsView";
import { createAgentSessionsFixture } from "./fixtures";

export function AgentSessionsDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createAgentSessionsFixture(zh);
  return <AgentSessionsView rows={fixture.rows} labels={fixture.labels} density={density} />;
}
