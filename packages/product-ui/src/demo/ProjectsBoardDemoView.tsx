import { ProjectsBoardView } from "../desktop/ProjectsBoardView";
import { createProjectsBoardFixture } from "./fixtures";

export function ProjectsBoardDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createProjectsBoardFixture(zh);
  return <ProjectsBoardView columns={fixture.columns} labels={fixture.labels} density={density} />;
}
