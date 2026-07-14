import React from "react";
import { Anchor, Button, Drawer, Group, Modal, PasswordInput, Stack, Switch, Text, TextInput } from "@mantine/core";
import { IconDatabaseImport, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { AccountBalanceSnapshot, AccountResourceMode, ChannelAccount, ChannelPreset, createAccount } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";
import { LongCatPackImportDialog, summarizeLongCatLots, parseSnapshotTokenPacks, formatTokenCount } from "./LongCatPackImportDialog";

export type AccountEditorRequest =
  | { mode: "create"; channelId: string }
  | { mode: "edit"; index: number };

type ResourceDraft = {
  balance: string;
  currency: string;
  tokenTotal: string;
  tokenUsed: string;
  tokenRemaining: string;
  tokenExpire: string;
  // LongCat 多资源包原始 JSON（导入后存储）
  tokenPacks: string;
};

type AccountEditorDrawerProps = {
  request: AccountEditorRequest;
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  onClose: () => void;
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void> | void;
  onTestConnection: (channelId: string, apiKey: string, baseUrlOverride?: string | null) => void;
  onSyncBalance: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
};

function toDateInput(value?: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function snapshotDraft(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): ResourceDraft {
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? (account.channel_id === "longcat" ? "USD" : "CNY"),
    tokenTotal: snapshot?.token_pack_total?.toString() ?? "",
    tokenUsed: snapshot?.token_pack_used?.toString() ?? "",
    tokenRemaining: snapshot?.token_pack_remaining?.toString() ?? "",
    tokenExpire: toDateInput(snapshot?.token_pack_expire_at),
    tokenPacks: snapshot?.token_packs ?? "",
  };
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTokens(value: number | null): string {
  if (value == null) return "-";
  return `${formatTokenCount(Math.max(0, value))} Tokens`;
}

function defaultResourceMode(channelId: string): AccountResourceMode {
  return channelId === "longcat" ? "token_pack" : "pay_as_you_go";
}

function createDraft(request: AccountEditorRequest, accounts: ChannelAccount[], channels: ChannelPreset[]): ChannelAccount {
  if (request.mode === "edit") return { ...accounts[request.index] };
  const count = accounts.filter((account) => account.channel_id === request.channelId).length;
  const draft = createAccount(request.channelId, count);
  const channel = channels.find((item) => item.id === request.channelId);
  return { ...draft, name: count === 0 ? `${channel?.name ?? "渠道"} 主账号` : `${channel?.name ?? "渠道"} 账号 ${count + 1}` };
}

export function AccountEditorDrawer({
  request,
  accounts,
  channels,
  onClose,
  onSaveAccounts,
  onTestConnection,
  onSyncBalance,
  getBalanceForAccount,
  onAddBalanceSnapshot,
}: AccountEditorDrawerProps) {
  const [draft, setDraft] = React.useState(() => createDraft(request, accounts, channels));
  const initialDraft = draft;
  const [resource, setResource] = React.useState(() => snapshotDraft(initialDraft, getBalanceForAccount(initialDraft.id)));
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const channel = channels.find((item) => item.id === draft.channel_id);
  const resourceMode = draft.resource_mode ?? defaultResourceMode(draft.channel_id);
  const tokenTotal = optionalNumber(resource.tokenTotal);
  const tokenUsed = optionalNumber(resource.tokenUsed);
  const tokenRemaining = tokenTotal != null && tokenUsed != null
    ? Math.max(0, tokenTotal - tokenUsed)
    : optionalNumber(resource.tokenRemaining);
  const autoSyncBalance = channel?.supports_balance_query === true;
  const balanceSnapshot = getBalanceForAccount(draft.id);
  const [importOpened, setImportOpened] = React.useState(false);
  const importedPacks = React.useMemo(
    () => parseSnapshotTokenPacks(resource.tokenPacks),
    [resource.tokenPacks],
  );
  // 只要填写了 API Key 就允许测试连接，与新建/编辑模式无关
  const canTestConnection = draft.api_key.trim().length > 0;

  function updateDraft(patch: Partial<ChannelAccount>) {
    setDraft((current) => ({ ...current, ...patch, updated_at: new Date().toISOString() }));
  }

  function selectChannel(channelId: string) {
    if (request.mode === "edit") return;
    const nextChannel = channels.find((item) => item.id === channelId);
    updateDraft({
      channel_id: channelId,
      resource_mode: defaultResourceMode(channelId),
      name: request.mode === "create" ? `${nextChannel?.name ?? "渠道"} 主账号` : draft.name,
      base_url_override: null,
    });
    setResource(snapshotDraft({ ...draft, channel_id: channelId }));
  }

  function handleImportLongCatPacks(lots: Parameters<typeof summarizeLongCatLots>[0]) {
    const summary = summarizeLongCatLots(lots);
    setResource((current) => ({
      ...current,
      tokenTotal: summary.total > 0 ? String(summary.total) : current.tokenTotal,
      tokenUsed: summary.used > 0 ? String(summary.used) : current.tokenUsed,
      tokenRemaining: summary.remaining > 0 ? String(summary.remaining) : current.tokenRemaining,
      tokenExpire: summary.expireAt ? toDateInput(summary.expireAt) : current.tokenExpire,
      tokenPacks: summary.source || current.tokenPacks,
    }));
    setImportOpened(false);
  }

  async function save() {
    const nextDraft = {
      ...draft,
      name: draft.name.trim(),
      api_key: draft.api_key.trim(),
      base_url_override: draft.base_url_override?.trim() || null,
    };
    if (!nextDraft.name || !nextDraft.api_key) {
      notifications.show({ message: "请填写账号名称和 API Key", color: "orange" });
      return;
    }
    const nextAccounts = request.mode === "create"
      ? [...accounts, nextDraft]
      : accounts.map((account, index) => index === request.index ? nextDraft : account);
    setSaving(true);
    try {
      await onSaveAccounts(nextAccounts);
      // 支持余额自动同步的渠道（DeepSeek）不需要手动快照，保存时已自动同步
      if (!autoSyncBalance) {
        const hasResource = resourceMode === "token_pack"
          ? Boolean(resource.tokenTotal.trim() || resource.tokenUsed.trim() || resource.tokenExpire.trim())
          : Boolean(resource.balance.trim());
        if (hasResource) {
          onAddBalanceSnapshot({
            account_id: nextDraft.id,
            balance: resourceMode === "pay_as_you_go" ? optionalNumber(resource.balance) : null,
            currency: resourceMode === "pay_as_you_go" ? resource.currency.trim() || null : null,
            token_pack_total: resourceMode === "token_pack" ? tokenTotal : null,
            token_pack_used: resourceMode === "token_pack" ? tokenUsed : null,
            token_pack_remaining: resourceMode === "token_pack" ? tokenRemaining : null,
            token_pack_expire_at: resourceMode === "token_pack" && resource.tokenExpire
              ? new Date(`${resource.tokenExpire}T00:00:00`).toISOString()
              : null,
            token_packs: resourceMode === "token_pack" && resource.tokenPacks.trim() ? resource.tokenPacks.trim() : null,
            source: "manual",
            synced_at: new Date().toISOString(),
            remark: null,
          });
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const [confirmOpened, setConfirmOpened] = React.useState(false);

  function openRemoveConfirm() {
    if (request.mode !== "edit") return;
    setConfirmOpened(true);
  }

  async function confirmRemove() {
    setConfirmOpened(false);
    if (request.mode !== "edit") return;
    await onSaveAccounts(accounts.filter((_, index) => index !== request.index));
    onClose();
  }

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size="min(760px, 94vw)"
      padding={0}
      zIndex={2000}
      classNames={{ root: "account-editor-drawer", header: "account-editor-header", body: "account-editor-body", title: "account-editor-title" }}
      title={
        <div>
          <strong>{request.mode === "create" ? "新增渠道账号" : "编辑渠道账号"}</strong>
          <span>{request.mode === "create" ? "添加 LongCat 或 DeepSeek 账号，用于上游模型转发" : `更新 ${draft.name} 的连接与资源信息`}</span>
        </div>
      }
    >
      <div className="account-editor-content">
        <section className="account-editor-section basic">
          <h3>基础信息</h3>
          <label><span className="account-key-label-row">选择渠道{request.mode === "edit" ? <small>（编辑时不可更改）</small> : null}</span></label>
          <div className="account-channel-options">
            {channels.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={request.mode === "edit"}
                className={draft.channel_id === item.id ? "account-channel-option selected" : "account-channel-option"}
                onClick={() => selectChannel(item.id)}
              >
                <span className="channel-logo-wrap"><ChannelLogo channelId={item.id} channelName={item.name} size={32} variant="avatar" /></span>
                <span><strong>{item.name}</strong><small>{item.vendor || `${item.name} 大模型服务`}</small></span>
                <i>{draft.channel_id === item.id ? "✓" : ""}</i>
              </button>
            ))}
          </div>

          <label>账号名称</label>
          <div className="account-name-input">
            <TextInput maxLength={50} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
            <span>{draft.name.length} / 50</span>
          </div>

          <label>
            <span className="account-key-label-row">
              API Key
              {channel?.platform_url ? (
                <Anchor
                  href={channel.platform_url}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                  className="account-api-key-link"
                >
                  <IconExternalLink size={12} />
                  前往查看
                </Anchor>
              ) : null}
            </span>
          </label>
          <PasswordInput value={draft.api_key} placeholder="请输入渠道 API Key" onChange={(event) => updateDraft({ api_key: event.target.value })} />

          <div className="account-enabled-row">
            <div><strong>启用状态</strong><small>停用后，该账号不会参与请求转发</small></div>
            <Switch checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })} />
            <span>{draft.enabled ? "已启用" : "已停用"}</span>
          </div>
        </section>

        <section className="account-editor-section resource">
          {autoSyncBalance ? (
            <div className="account-section-heading">
              <div><h3>资源模式</h3><small>按量付费，余额自动同步</small></div>
            </div>
          ) : (
            <div className="account-section-heading">
              <div><h3>资源模式</h3><small>一个渠道仅支持一种资源模式，保存后按所选模式维护信息</small></div>
            </div>
          )}
          {autoSyncBalance ? (
            <div className="account-resource-details payg">
              <div className="account-resource-details-heading">
                <strong>按量付费信息</strong>
                <span className="sync-badge">自动同步</span>
              </div>
              <div className="account-resource-grid">
                <label>账户余额<div className="static-field">{balanceSnapshot?.balance != null ? `${balanceSnapshot.balance} ${balanceSnapshot.currency ?? ""}` : "尚未同步"}</div></label>
                <label>货币<div className="static-field">{balanceSnapshot?.currency ?? "跟随上游返回"}</div></label>
              </div>
              {request.mode === "edit" ? (
                <div className="resource-sync-action">
                  <Button type="button" variant="subtle" size="xs" leftSection={<IconRefresh size={13} />} onClick={() => onSyncBalance(draft.id)}>
                    刷新余额
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="account-resource-mode-options">
                <button
                  type="button"
                  className={resourceMode === "token_pack" ? "account-resource-mode selected" : "account-resource-mode"}
                  aria-pressed={resourceMode === "token_pack"}
                  onClick={() => updateDraft({ resource_mode: "token_pack" })}
                >
                  <i aria-hidden="true" />
                  <span><strong>Token 资源包</strong><small>预付费，手动维护资源包信息</small></span>
                </button>
                <button
                  type="button"
                  className={resourceMode === "pay_as_you_go" ? "account-resource-mode selected" : "account-resource-mode"}
                  aria-pressed={resourceMode === "pay_as_you_go"}
                  onClick={() => updateDraft({ resource_mode: "pay_as_you_go" })}
                >
                  <i aria-hidden="true" />
                  <span><strong>API 按量付费</strong><small>后付费，手动维护余额</small></span>
                </button>
              </div>
              {resourceMode === "token_pack" ? (
                <div className="account-resource-details">
                  <div className="account-resource-details-heading">
                    <strong>资源包信息</strong>
                    <span className="sync-badge warn">手动维护</span>
                  </div>
                  {channel?.id === "longcat" ? (
                    <div className="account-longcat-import">
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        leftSection={<IconDatabaseImport size={13} />}
                        onClick={() => setImportOpened(true)}
                      >
                        导入 LongCat 资源包
                      </Button>
                      <small>从 F12 捕获的 /token-packs/summary 响应中导入，自动汇总多资源包。</small>
                    </div>
                  ) : null}
                  {importedPacks.length > 0 ? (
                    <div className="account-longcat-packs">
                      <input type="hidden" data-token-packs={resource.tokenPacks} />
                      <div className="account-longcat-packs-heading">
                        <span>已导入 {importedPacks.length} 个资源包</span>
                      </div>
                      <div className="longcat-packs-summary">
                        <span>总量 <strong>{formatTokens(tokenTotal)}</strong></span>
                        <span>已消耗 <strong>{formatTokens(tokenUsed)}</strong></span>
                        <span>剩余 <strong>{formatTokens(tokenRemaining)}</strong></span>
                        <span>最早到期 <strong>{resource.tokenExpire || "-"}</strong></span>
                      </div>
                    </div>
                  ) : null}
                  <div className="account-resource-grid longcat">
                    <label>资源包总量（Tokens）<TextInput type="number" min="0" value={resource.tokenTotal} onChange={(event) => setResource({ ...resource, tokenTotal: event.target.value })} /></label>
                    <label>已消耗（Tokens）<TextInput type="number" min="0" value={resource.tokenUsed} onChange={(event) => setResource({ ...resource, tokenUsed: event.target.value })} /></label>
                    <label className="account-token-remaining">剩余（Tokens）<strong>{formatTokens(tokenRemaining)}</strong></label>
                    <label className="account-token-expire">到期时间<TextInput type="date" value={resource.tokenExpire} onChange={(event) => setResource({ ...resource, tokenExpire: event.target.value })} /><small>到期后将无法使用，建议及时补充或更新资源包。</small></label>
                  </div>
                </div>
              ) : (
                <div className="account-resource-details payg">
                  <div className="account-resource-details-heading"><strong>按量付费信息</strong><span className="sync-badge warn">手动维护</span></div>
                  <div className="account-resource-grid">
                    <label>账户余额<TextInput type="number" min="0" step="0.01" placeholder="手动填写" value={resource.balance} onChange={(event) => setResource({ ...resource, balance: event.target.value })} /></label>
                    <label>货币<TextInput value={resource.currency} onChange={(event) => setResource({ ...resource, currency: event.target.value })} /></label>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section className="account-editor-section advanced">
          <button type="button" className="account-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
            <span><strong>高级设置</strong><small>自定义连接地址与测试账号状态</small></span><b>{advancedOpen ? "⌃" : "⌄"}</b>
          </button>
          {advancedOpen ? (
            <div className="account-advanced-content">
              <label>Base URL 覆盖（可选）<TextInput value={draft.base_url_override ?? ""} placeholder={channel?.openai_base_url} onChange={(event) => updateDraft({ base_url_override: event.target.value || null })} /></label>
              <div><Button variant="default" disabled={!canTestConnection} onClick={() => onTestConnection(draft.channel_id, draft.api_key, draft.base_url_override)}>测试连接</Button><span>{draft.last_error || "填写 API Key 后可测试真实上游连接"}</span></div>
            </div>
          ) : null}
        </section>

        {request.mode === "edit" ? (
          <section className="account-editor-danger"><div><strong>删除账号</strong><span>删除后将退出所有路由，且无法恢复</span></div><Button variant="subtle" color="red" onClick={openRemoveConfirm}>删除</Button></section>
        ) : null}

        <Modal
          opened={confirmOpened}
          onClose={() => setConfirmOpened(false)}
          title="确认删除账号"
          size="sm"
          zIndex={2100}
          centered
        >
          <Stack gap="md">
            <Text size="sm">确定要删除账号「{draft.name}」吗？删除后将退出所有路由，且无法恢复。</Text>
            <Group justify="flex-end">
              <Button variant="subtle" onClick={() => setConfirmOpened(false)}>取消</Button>
              <Button color="red" onClick={() => void confirmRemove()}>确认删除</Button>
            </Group>
          </Stack>
        </Modal>
      </div>

      <LongCatPackImportDialog
        opened={importOpened}
        onClose={() => setImportOpened(false)}
        onImport={(lots) => handleImportLongCatPacks(lots)}
      />

      <footer className="account-editor-footer">
        <Button variant="default" onClick={onClose}>取消</Button>
        <Button variant="default" disabled={!canTestConnection} onClick={() => onTestConnection(draft.channel_id, draft.api_key, draft.base_url_override)}>测试连接</Button>
        <Button loading={saving} onClick={() => void save()}>{request.mode === "create" ? "保存账号" : "保存修改"}</Button>
      </footer>
    </Drawer>
  );
}
