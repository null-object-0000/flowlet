import { useMemo, useState } from "react";
import { AgentSessionsView } from "../desktop/AgentSessionsView";
import { createAgentSessionsFixture } from "./fixtures";
import { DemoFilterToolbar, DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";

export function AgentSessionsDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createAgentSessionsFixture(zh);
  const [search, setSearch] = useState("");
  const rows = useMemo(() => fixture.rows.filter((row) => !search.trim() || [row.title, row.subtitle, row.client].join(" ").toLowerCase().includes(search.trim().toLowerCase())), [fixture.rows, search]);
  return <DemoPageScaffold
    title={zh ? "会话管理" : "Sessions"}
    subtitle={zh ? "统一查看 Agent 本地会话与 Flowlet 请求观测" : "Review native agent sessions alongside Flowlet request observations"}
    controls={<DemoRefreshControl zh={zh} />}
  >
    <AgentSessionsView
      rows={rows}
      labels={{ ...fixture.labels, total: zh ? `共 ${rows.length} 个主会话` : `${rows.length} sessions total` }}
      density={density}
      toolbar={<DemoFilterToolbar value={search} placeholder={zh ? "搜索会话标题、ID 或项目目录" : "Search session titles, IDs or project paths"} filters={zh ? ["全部客户端", "全部状态"] : ["All clients", "All statuses"]} onChange={setSearch} />}
    />
  </DemoPageScaffold>;
}
