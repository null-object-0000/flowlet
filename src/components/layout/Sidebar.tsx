import { View, views } from "../../domain";

type SidebarProps = {
  view: View;
  onViewChange: (view: View) => void;
};

export function Sidebar({ view, onViewChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div>
        <h1>Flowlet</h1>
        <p>本地 AI 请求路由客户端</p>
      </div>
      <nav>
        {views.map((item) => (
          <button
            className={view === item.id ? "nav-item active" : "nav-item"}
            key={item.id}
            onClick={() => onViewChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
