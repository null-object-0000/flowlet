import { RequestLogsView } from "../desktop/RequestLogsView";
import { createRequestLogsFixture } from "./fixtures";

export function RequestLogsDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createRequestLogsFixture(zh);
  return <RequestLogsView stats={fixture.stats} rows={fixture.rows} labels={fixture.labels} density={density} />;
}
