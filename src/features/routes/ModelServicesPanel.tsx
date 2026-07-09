import { Button, Select, Switch } from "@mantine/core";
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
          <Button type="button" variant="default" onClick={onRegenerateDefaultRoutes}>同步模型</Button>
          <Button type="button" onClick={() => void onSave()}>保存模型服务</Button>
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
                <Select
                  value={model.accountId}
                  onChange={(value) => value && switchModelAccount(model.routeIndexes, value)}
                  data={channelAccounts.map((account) => ({ value: account.id, label: account.name }))}
                  placeholder="选择账号"
                />
                <span className="muted">{accountCountLabel(model.accountIds.length)}</span>
                <ProtocolBadges protocols={model.protocols} />
                <StatusPill running={model.enabled}>{stateLabel}</StatusPill>
                <Switch checked={model.enabled} onChange={(event) => setModelEnabled(model.routeIndexes, event.currentTarget.checked)} />
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
