import React from "react";
import { Button, Drawer, PasswordInput, Switch, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset, createAccount } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";

export type AccountEditorRequest =
  | { mode: "create"; channelId: string }
  | { mode: "edit"; index: number };

type ResourceDraft = {
  balance: string;
  currency: string;
};

type AccountEditorDrawerProps = {
  request: AccountEditorRequest;
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  onClose: () => void;
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void> | void;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
};

function snapshotDraft(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): ResourceDraft {
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? (account.channel_id === "longcat" ? "USD" : "CNY"),
  };
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  getBalanceForAccount,
  onAddBalanceSnapshot,
}: AccountEditorDrawerProps) {
  const [draft, setDraft] = React.useState(() => createDraft(request, accounts, channels));
  const initialDraft = draft;
  const [resource, setResource] = React.useState(() => snapshotDraft(initialDraft, getBalanceForAccount(initialDraft.id)));
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const channel = channels.find((item) => item.id === draft.channel_id);

  function updateDraft(patch: Partial<ChannelAccount>) {
    setDraft((current) => ({ ...current, ...patch, updated_at: new Date().toISOString() }));
  }

  function selectChannel(channelId: string) {
    const nextChannel = channels.find((item) => item.id === channelId);
    updateDraft({
      channel_id: channelId,
      resource_mode: "pay_as_you_go",
      name: request.mode === "create" ? `${nextChannel?.name ?? "渠道"} 主账号` : draft.name,
      base_url_override: null,
    });
    setResource(snapshotDraft({ ...draft, channel_id: channelId }));
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
      const hasResource = Boolean(resource.balance.trim());
      if (hasResource) {
        onAddBalanceSnapshot({
          account_id: nextDraft.id,
          balance: optionalNumber(resource.balance),
          currency: resource.currency.trim() || null,
          token_pack_total: null,
          token_pack_used: null,
          token_pack_remaining: null,
          token_pack_expire_at: null,
          source: "manual",
          synced_at: new Date().toISOString(),
          remark: null,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
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
          <label>选择渠道</label>
          <div className="account-channel-options">
            {channels.map((item) => (
              <button
                type="button"
                key={item.id}
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

          <label>API Key</label>
          <PasswordInput value={draft.api_key} placeholder="请输入渠道 API Key" onChange={(event) => updateDraft({ api_key: event.target.value })} />

          <div className="account-enabled-row">
            <div><strong>启用状态</strong><small>停用后，该账号不会参与请求转发</small></div>
            <Switch checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })} />
            <span>{draft.enabled ? "已启用" : "已停用"}</span>
          </div>
        </section>

        {channel?.supports_balance_query !== true ? (
          <section className="account-editor-section resource">
            <div className="account-section-heading">
              <div><h3>资源模式</h3><small>按量付费，手动维护余额信息</small></div>
            </div>
            <div className="account-resource-details payg">
              <div className="account-resource-details-heading"><strong>按量付费信息</strong><span className="sync-badge">手动维护</span></div>
              <div className="account-resource-grid">
                <label>账户余额<TextInput type="number" min="0" step="0.01" placeholder="手动填写" value={resource.balance} onChange={(event) => setResource({ ...resource, balance: event.target.value })} /></label>
                <label>货币<TextInput value={resource.currency} onChange={(event) => setResource({ ...resource, currency: event.target.value })} /></label>
              </div>
            </div>
          </section>
        ) : (
          <section className="account-editor-section resource">
            <div className="account-section-heading">
              <div><h3>资源模式</h3><small>按量付费，保存后自动同步余额</small></div>
            </div>
            <div className="account-resource-details payg">
              <div className="account-resource-details-heading"><strong>按量付费信息</strong><span className="sync-badge">自动同步</span></div>
              <div className="account-resource-grid">
                <label>账户余额<div className="static-field">保存后自动从上游同步</div></label>
                <label>货币<div className="static-field">跟随上游返回</div></label>
              </div>
            </div>
          </section>
        )}

        <section className="account-editor-section advanced">
          <button type="button" className="account-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
            <span><strong>高级设置</strong><small>自定义连接地址与测试账号状态</small></span><b>{advancedOpen ? "⌃" : "⌄"}</b>
          </button>
          {advancedOpen ? (
            <div className="account-advanced-content">
              <label>Base URL 覆盖（可选）<TextInput value={draft.base_url_override ?? ""} placeholder={channel?.openai_base_url} onChange={(event) => updateDraft({ base_url_override: event.target.value || null })} /></label>
              <div><Button variant="default" disabled={request.mode === "create"} onClick={() => onTestConnection(draft.id)}>测试连接</Button><span>{draft.last_error || "保存账号后可测试真实上游连接"}</span></div>
            </div>
          ) : null}
        </section>

        {request.mode === "edit" ? (
          <section className="account-editor-danger"><div><strong>删除账号</strong><span>删除后将退出所有路由，且无法恢复</span></div><Button variant="subtle" color="red" onClick={() => void remove()}>删除</Button></section>
        ) : null}
      </div>

      <footer className="account-editor-footer">
        <Button variant="default" onClick={onClose}>取消</Button>
        <Button variant="default" disabled={request.mode === "create"} onClick={() => onTestConnection(draft.id)}>测试连接</Button>
        <Button loading={saving} onClick={() => void save()}>{request.mode === "create" ? "保存账号" : "保存修改"}</Button>
      </footer>
    </Drawer>
  );
}
