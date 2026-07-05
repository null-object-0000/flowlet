import { Actions, EmptyState, Panel, PanelHeader, ProtocolBadges, StatusPill } from "../../components/ui";
import { ChannelAccount, RouteCandidate } from "../../domain";
import { accountCountLabel, buildExposedModels } from "./exposedModels";

type ModelServicesPanelProps = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  getChannelName: (channelId: string) => string;
};

export function ModelServicesPanel({ routes, accounts, onUpdate, onSave, onRegenerateDefaultRoutes, getChannelName }: ModelServicesPanelProps) {
  const exposedModels = buildExposedModels(routes, accounts);

  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdate(routeIndex, { enabled }));
  }

  function switchModelAccount(routeIndexes: number[], accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    routeIndexes.forEach((routeIndex) => onUpdate(routeIndex, { account_id: account.id, channel_id: account.channel_id }));
  }

  return (
    <Panel>
      <PanelHeader>
        <h3>模型服务</h3>
        <Actions>
          <button type="button" onClick={onRegenerateDefaultRoutes}>同步模型</button>
          <button type="button" className="primary" onClick={() => void onSave()}>保存模型服务</button>
        </Actions>
      </PanelHeader>
      {exposedModels.length === 0 ? (
        <EmptyState>
          <p>当前没有对外开放模型。</p>
          <p>请先在概览页添加并启用上游账号，系统会自动开放该渠道默认模型。</p>
        </EmptyState>
      ) : (
        <div className="model-service-list">
          {exposedModels.map((model) => {
            const channelAccounts = accounts.filter((account) => account.channel_id === model.channelId);
            const stateLabel = model.enabled ? "已开放" : "已关闭";
            return (
              <div className="model-service-row" key={`${model.channelId}:${model.publicModel}`}>
                <div className="row-main">
                  <strong>{model.publicModel}</strong>
                  <span className="muted">上游模型：{model.upstreamModel || "-"}</span>
                </div>
                <span>{getChannelName(model.channelId)}</span>
                <select value={model.accountId} onChange={(event) => switchModelAccount(model.routeIndexes, event.target.value)}>
                  {channelAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
                <span className="muted">{accountCountLabel(model.accountIds.length)}</span>
                <ProtocolBadges protocols={model.protocols} />
                <StatusPill running={model.enabled}>{stateLabel}</StatusPill>
                <button type="button" onClick={() => setModelEnabled(model.routeIndexes, !model.enabled)}>
                  {model.enabled ? "关闭" : "开放"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="hint">
        模型开放/关闭、账号切换保存后代理自动热更新。高级 route candidate 与规则路由在下方高级区域维护。
      </p>
    </Panel>
  );
}
