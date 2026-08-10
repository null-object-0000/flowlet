import { useMemo, useState } from "react";
import { RequestLogsView } from "../desktop/RequestLogsView";
import { createRequestLogsFixture } from "./fixtures";
import { DemoFilterToolbar, DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";

export function RequestLogsDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createRequestLogsFixture(zh);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(0);
  const rows = useMemo(() => fixture.rows.filter((row) => {
    const matchesSearch = !search.trim() || [row.id, row.client, row.model, row.channel, row.account].join(" ").toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = status === 0 || (status === 1 ? row.status === "success" : row.status === "failure");
    return matchesSearch && matchesStatus;
  }), [fixture.rows, search, status]);
  return <DemoPageScaffold
    title={zh ? "请求日志" : "Request log"}
    subtitle={zh ? "查看代理服务的实时请求、模型路由和 Token 消耗" : "Inspect live proxy requests, model routes and token usage"}
    controls={<DemoRefreshControl zh={zh} range={zh ? "今天" : "Today"} />}
  >
    <RequestLogsView
      stats={fixture.stats}
      rows={rows}
      labels={fixture.labels}
      density={density}
      toolbar={<DemoFilterToolbar
        value={search}
        placeholder={zh ? "搜索请求 ID、模型、账号或会话" : "Search request, model, account or session"}
        filters={[zh ? "全部客户端" : "All clients", zh ? "全部模型" : "All models"]}
        statuses={zh ? ["全部", "成功", "失败"] : ["All", "Success", "Failed"]}
        activeStatus={status}
        onChange={setSearch}
        onStatusChange={setStatus}
      />}
      footer={<span>{zh ? `当前显示 ${rows.length} 条` : `${rows.length} shown`}</span>}
    />
  </DemoPageScaffold>;
}
