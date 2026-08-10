import { useMemo, useState } from "react";
import { ProjectsBoardView } from "../desktop/ProjectsBoardView";
import { createProjectsBoardFixture } from "./fixtures";
import { DemoFilterToolbar, DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";

export function ProjectsBoardDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createProjectsBoardFixture(zh);
  const [search, setSearch] = useState("");
  const columns = useMemo(() => fixture.columns.map((column) => {
    const tasks = column.tasks?.filter((task) => !search.trim() || [task.title, task.roundLabel, task.contextLabel].join(" ").toLowerCase().includes(search.trim().toLowerCase())) ?? [];
    return {
      ...column,
      tasks,
      count: tasks.length,
      addAction: column.id === "queued" ? { label: zh ? "添加任务" : "Add task", onClick: () => undefined } : undefined,
    };
  }), [fixture.columns, search, zh]);
  return <DemoPageScaffold
    title="flowlet"
    subtitle="D:\\flowlet"
    controls={<><DemoFilterToolbar value={search} placeholder={zh ? "搜索任务标题、ID 或描述" : "Search tasks, IDs or descriptions"} onChange={setSearch} /><DemoRefreshControl zh={zh} /></>}
  >
    <ProjectsBoardView columns={columns} labels={fixture.labels} density={density} />
  </DemoPageScaffold>;
}
