import { ActionIcon, Badge, Button, Group, Switch, Text } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconCopy, IconPlayerPlay, IconSettings } from "@tabler/icons-react";
import { Actions, Panel, PanelHeader } from "../../components/ui";
import { ChannelAccount, RouteCandidate, flowletPublicModels } from "../../domain";

type ModelServicesPanelProps = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  onCopyModel: (model: string) => void;
  onTestModel: (model: string) => void;
  onToggleAccount: (accountId: string, enabled: boolean) => void;
  onOpenAccounts?: () => void;
};

// 账号凭证状态 → 展示文案（用于模型详情中的只读状态）。
function credentialStatusLabel(status: ChannelAccount["credential_status"]): string {
  switch (status) {
    case "invalid_key":
      return "API Key 无效";
    default:
      return "已启用";
  }
}

const TIERS = [flowletPublicModels.pro, flowletPublicModels.flash];

export function ModelServicesPanel({
  routes,
  accounts,
  onUpdate,
  onSave,
  onRegenerateDefaultRoutes,
  onCopyModel,
  onTestModel,
  onToggleAccount,
  onOpenAccounts,
}: ModelServicesPanelProps) {
  const availableAccountIds = new Set(
    accounts
      .filter((account) => account.enabled && account.api_key.trim() && account.credential_status !== "invalid_key")
      .map((account) => account.id)
  );

  function updateRoutes(indexes: number[], patch: Partial<RouteCandidate>) {
    indexes.forEach((index) => onUpdate(index, patch));
  }

  return (
    <Panel className="flowlet-models-panel">
      <PanelHeader>
        <div>
          <h3>模型服务</h3>
          <Text size="sm" c="dimmed">客户端只需使用 Flowlet Pro 或 Flowlet Flash，底层模型和账号由 Flowlet 自动管理。</Text>
        </div>
        <Actions>
          <Button type="button" variant="default" onClick={onRegenerateDefaultRoutes}>重新识别模型池</Button>
          <Button type="button" onClick={() => void onSave()}>保存更改</Button>
        </Actions>
      </PanelHeader>

      <div className="flowlet-tier-grid">
        {TIERS.map((tier) => {
          const tierRouteEntries = routes
            .map((route, index) => ({ route, index }))
            .filter(({ route }) => route.virtual_model_id === tier.id);
          const underlying = [...new Map(
            tierRouteEntries.map(({ route }) => [
              `${route.channel_id}:${route.upstream_model}`,
              { channelId: route.channel_id, model: route.upstream_model, priority: route.priority },
            ])
          ).values()].sort((a, b) => a.priority - b.priority || a.model.localeCompare(b.model));
          const availableRoutes = tierRouteEntries.filter(
            ({ route }) => route.enabled && availableAccountIds.has(route.account_id)
          );
          const accountCount = new Set(availableRoutes.map(({ route }) => route.account_id)).size;
          const isAvailable = underlying.length > 0 && availableRoutes.length > 0;
          const tierEnabled = tierRouteEntries.some(({ route }) => route.enabled);

          return (
            <section className="flowlet-tier-card" key={tier.id}>
              <header className="flowlet-tier-card-header">
                <div>
                  <Group gap="xs">
                    <h4>{tier.name}</h4>
                    <Badge color={isAvailable ? "green" : "gray"} variant="light">{isAvailable ? "可用" : "不可用"}</Badge>
                  </Group>
                  <code>{tier.id}</code>
                  <p>{tier.description}</p>
                </div>
                <Switch
                  checked={tierEnabled}
                  disabled={tierRouteEntries.length === 0}
                  onChange={(event) => updateRoutes(tierRouteEntries.map(({ index }) => index), { enabled: event.currentTarget.checked })}
                  aria-label={`${tier.name} 启用状态`}
                />
              </header>

              <div className="flowlet-tier-stats">
                <span><strong>{underlying.length}</strong> 个底层模型</span>
                <span><strong>{accountCount}</strong> 个可用账号</span>
              </div>

              <Group gap="sm">
                <Button variant="default" leftSection={<IconCopy size={15} />} onClick={() => onCopyModel(tier.id)}>复制模型名</Button>
                <Button variant="light" leftSection={<IconPlayerPlay size={15} />} disabled={!isAvailable} onClick={() => onTestModel(tier.id)}>测试请求</Button>
              </Group>

              <details className="flowlet-model-details">
                <summary>查看模型池</summary>
                {underlying.length === 0 ? <Text size="sm" c="dimmed">接入支持双协议的渠道账号后自动生成。</Text> : null}
                {underlying.map((item, modelIndex) => {
                  const entries = tierRouteEntries.filter(({ route }) => route.channel_id === item.channelId && route.upstream_model === item.model);
                  const modelAccounts = new Set(entries.filter(({ route }) => availableAccountIds.has(route.account_id)).map(({ route }) => route.account_id));
                  const relatedAccountIds = [...new Set(entries.map(({ route }) => route.account_id))];
                  const relatedAccounts = relatedAccountIds.map((id) => accounts.find((account) => account.id === id)).filter((account): account is ChannelAccount => !!account);
                  const enabled = entries.some(({ route }) => route.enabled);
                  const previous = underlying[modelIndex - 1];
                  const next = underlying[modelIndex + 1];
                  return (
                    <div className="flowlet-underlying-row" key={`${item.channelId}:${item.model}`}>
                      <div>
                        <strong>{item.model}</strong>
                        <span>{modelAccounts.size} 个可用账号 · {enabled ? "可用" : "已停用"}</span>
                        <div className="flowlet-related-accounts">
                          {relatedAccounts.map((account) => (
                            <span key={account.id} className="flowlet-related-account">
                              {account.name} · {account.enabled ? credentialStatusLabel(account.credential_status) : "已停用"}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Group gap={4} wrap="nowrap">
                        <ActionIcon variant="subtle" disabled={!previous} aria-label="上移底层模型" onClick={() => {
                          if (!previous) return;
                          updateRoutes(entries.map(({ index }) => index), { priority: previous.priority });
                          const previousEntries = tierRouteEntries.filter(({ route }) => route.channel_id === previous.channelId && route.upstream_model === previous.model);
                          updateRoutes(previousEntries.map(({ index }) => index), { priority: item.priority });
                        }}><IconArrowUp size={16} /></ActionIcon>
                        <ActionIcon variant="subtle" disabled={!next} aria-label="下移底层模型" onClick={() => {
                          if (!next) return;
                          updateRoutes(entries.map(({ index }) => index), { priority: next.priority });
                          const nextEntries = tierRouteEntries.filter(({ route }) => route.channel_id === next.channelId && route.upstream_model === next.model);
                          updateRoutes(nextEntries.map(({ index }) => index), { priority: item.priority });
                        }}><IconArrowDown size={16} /></ActionIcon>
                        <Switch checked={enabled} onChange={(event) => updateRoutes(entries.map(({ index }) => index), { enabled: event.currentTarget.checked })} aria-label={`${item.model} 启用状态`} />
                      </Group>
                    </div>
                  );
                })}
                <div className="flowlet-model-details-footer">
                  <Button variant="subtle" size="xs" leftSection={<IconSettings size={14} />} onClick={onOpenAccounts}>
                    管理渠道账号
                  </Button>
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </Panel>
  );
}