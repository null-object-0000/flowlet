import { ProxyStatus } from "../../domain";

type ProxyTopbarProps = {
  status: ProxyStatus;
  onStart: () => void;
  onStop: () => void;
};

export function ProxyTopbar({ status, onStart, onStop }: ProxyTopbarProps) {
  return (
    <header className="topbar">
      <div>
        <h2>代理服务</h2>
        <p>{status.running ? "正在监听本地请求" : "代理服务未启动"}</p>
      </div>
      <div className="topbar-actions">
        <button type="button" onClick={onStart} disabled={status.running}>
          启动
        </button>
        <button type="button" onClick={onStop} disabled={!status.running}>
          停止
        </button>
        <div className={status.running ? "status running" : "status"}>
          {status.running ? "运行中" : "已停止"}
        </div>
      </div>
    </header>
  );
}
