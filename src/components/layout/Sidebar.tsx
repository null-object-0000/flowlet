import { ProxyStatus, View, views } from "../../domain";

type SidebarProps = {
  view: View;
  status: ProxyStatus;
  onViewChange: (view: View) => void;
};

const iconPaths: Record<View, string> = {
  overview: "M3 10.8 12 3l9 7.8v8.7a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5v-8.7Z M9 21v-6h6v6",
  logs: "M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z M15 3.5V7h3 M8 11h8 M8 15h8",
  usage: "M5 19V9 M10 19V5 M15 19v-7 M20 19V8",
  stats: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z M12 8v8 M8 10.2l4 2.3 4-2.3",
};

function NavIcon({ view }: { view: View }) {
  return (
    <svg className="nav-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d={iconPaths[view]} />
    </svg>
  );
}

export function Sidebar({ view, status, onViewChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">F</span>
        <h1>Flowlet</h1>
        <span className="version-pill">v0.1.0</span>
      </div>
      <nav>
        {views.map((item) => (
          <button
            type="button"
            className={view === item.id ? "nav-item active" : "nav-item"}
            key={item.id}
            onClick={() => onViewChange(item.id)}
          >
            <span className="nav-icon" aria-hidden="true">
              <NavIcon view={item.id} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-status">
        <span className={status.running ? "status-dot" : "status-dot muted"} />
        <strong>{status.running ? "服务运行中" : "服务已停止"}</strong>
        <small>{status.running ? "代理正在监听本地请求" : "等待启动代理服务"}</small>
      </div>
    </aside>
  );
}
