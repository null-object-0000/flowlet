import { ActionIcon, Badge, Box, Button, Group, Radio, Switch, Table, Text } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconCopy, IconPlayerPlay, IconSettings } from "@tabler/icons-react";
import { Actions, Panel, PanelHeader } from "../../components/ui";
import {
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  ModelExposureMode,
  RouteCandidate,
  flowletPublicModels,
} from "../../domain";
import { buildExposedModels, ExposedModel } from "./exposedModels";

type ModelServicesPanelProps = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  channels?: ChannelPreset[];
  channelModels?: ChannelModel[];
  exposureMode: ModelExposureMode;
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  onCopyModel: (model: string) => void;
  onTestModel: (model: string) => void;
  onChangeExposureMode: (mode: ModelExposureMode) => void;
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
  channels = [],
  channelModels = [],
  exposureMode,
  onUpdate,
  onSave,
  onRegenerateDefaultRoutes,
  onCopyModel,
  onTestModel,
  onChangeExposureMode,
  onOpenAccounts,
}: ModelServicesPanelProps) {
  const availableAccountIds = new Set(
    accounts
      .filter((account) => account.enabled && account.api_key.trim() && account.credential_status !== "invalid_key")
      .map((account) => account.id)
  );

  const exposedModels = buildExposedModels(routes, accounts, channels, channelModels);
  const aggregateModels = exposedModels.filter((model) => model.kind === "aggregate");
  const directModels = exposedModels.filter((model) => model.kind === "direct");

  function updateRoutes(indexes: number[], patch: Partial<RouteCandidate>) {
    indexes.forEach((index) => onUpdate(index, patch));
  }

  function toggleDirectModel(model: ExposedModel, enabled: boolean) {
    updateRoutes(model.routeIndexes, { enabled });
  }

  return (
    <Panel className="flowlet-models-panel">
      <PanelHeader>
        <div>
          <h3>模型服务</h3>
          <Text size="sm" c="dimmed">
            {exposureMode === "flowlet_only"
              ? "当前仅对外开放 Flowlet Pro / Flash 聚合模型。"
              : "Flowlet 聚合模型与直接底层模型均对外开放，可在「自定义」模式下单独控制。"}
          </Text>
        </div>
        <Actions>
          <Button type="button" variant="default" onClick={onRegenerateDefaultRoutes}>
            重新识别模型池
          </Button>
          <Button type="button" onClick={() => void onSave()}>
            保存更改
          </Button>
        </Actions>
      </PanelHeader>

      {/* 顶部：模型开放范围 */}
      <Box className="flowlet-exposure-mode">
        <Text size="sm" fw={600} mb="xs">模型开放范围</Text>
        <Radio.Group value={exposureMode} onChange={(value) => onChangeExposureMode(value as ModelExposureMode)}>
          <Group gap="lg">
            <Radio value="all" label="全部开放（推荐）" />
            <Radio value="flowlet_only" label="仅 Flowlet 模型" />
            <Radio value="custom" label="自定义" />
          </Group>
        </Radio.Group>
        {exposureMode === "all" ? (
          <Text size="xs" c="dimmed" mt={4}>所有聚合模型与底层模型均开放。如需单独控制，请切换至「自定义」。</Text>
        ) : null}
      </Box>

      {/* 区域一：Flowlet 智能模型 */}
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

      {/* 区域二：直接模型 */}
      <Box className="flowlet-direct-models" mt="lg">
        <Text size="sm" fw={600} mb="xs">直接模型</Text>
        {exposureMode === "flowlet_only" ? (
          <Text size="sm" c="dimmed">当前为「仅 Flowlet 模型」模式，直接底层模型不对外开放。</Text>
        ) : directModels.length === 0 ? (
          <Text size="sm" c="dimmed">接入渠道账号后自动发现底层模型。</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>模型</Table.Th>
                <Table.Th>渠道</Table.Th>
                <Table.Th>可用账号</Table.Th>
                <Table.Th>对外开放</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {directModels.map((model) => {
                const disabledByMode = exposureMode === "all"; // 全部开放模式下直接模型开关只读，需切自定义
                return (
                  <Table.Tr key={model.publicModel}>
                    <Table.Td>
                      <code>{model.publicModel}</code>
                      {model.hasAvailableAccount ? (
                        <Badge color="green" variant="light" size="xs" ml={6}>可用</Badge>
                      ) : (
                        <Badge color="gray" variant="light" size="xs" ml={6}>不可用</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>{model.channelName ?? model.channelId ?? "-"}</Table.Td>
                    <Table.Td>{model.availableAccountCount}</Table.Td>
                    <Table.Td>
                      <Switch
                        checked={model.enabled}
                        disabled={disabledByMode}
                        aria-label={`${model.publicModel} 对外开放`}
                        onChange={(event) => toggleDirectModel(model, event.currentTarget.checked)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <ActionIcon variant="subtle" aria-label="复制模型名" onClick={() => onCopyModel(model.publicModel)}>
                          <IconCopy size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          disabled={!model.hasAvailableAccount}
                          aria-label="测试直接模型"
                          onClick={() => onTestModel(model.publicModel)}
                        >
                          <IconPlayerPlay size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Box>
    </Panel>
  );
}
