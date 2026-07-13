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
  tokenTotal: string;
  tokenUsed: string;
  tokenRemaining: string;
  tokenExpire: string;
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

function toDatetimeLocal(value?: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function snapshotDraft(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): ResourceDraft {
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? (account.channel_id === "longcat" ? "USD" : "CNY"),
    tokenTotal: snapshot?.token_pack_total?.toString() ?? "",
    tokenUsed: snapshot?.token_pack_used?.toString() ?? "",
    tokenRemaining: snapshot?.token_pack_remaining?.toString() ?? "",
    tokenExpire: toDatetimeLocal(snapshot?.token_pack_expire_at),
  };
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function channelMark(channelId: string): string {
  if (channelId === "longcat") return "LC";
  if (channelId === "deepseek") return "DS";
  return channelId.slice(0, 2).toUpperCase();
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
      const hasResource = Object.entries(resource).some(([key, value]) => key !== "currency" && value.trim());
      if (hasResource) {
        const isLongCat = nextDraft.channel_id === "longcat";
        onAddBalanceSnapshot({
          account_id: nextDraft.id,
          balance: isLongCat ? null : optionalNumber(resource.balance),
          currency: resource.currency.trim() || null,
          token_pack_total: isLongCat ? optionalNumber(resource.tokenTotal) : null,
          token_pack_used: isLongCat ? optionalNumber(resource.tokenUsed) : null,
          token_pack_remaining: isLongCat ? optionalNumber(resource.tokenRemaining) : null,
          token_pack_expire_at: resource.tokenExpire ? new Date(resource.tokenExpire).toISOString() : null,
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

        <section className="account-editor-section resource">
          <div className="account-section-heading">
            <div><h3>{draft.channel_id === "longcat" ? "资源包信息（手动维护）" : "余额信息"}</h3><small>{draft.channel_id === "longcat" ? "LongCat 暂不支持自动同步" : "可保存快照或连接后同步"}</small></div>
            <span className={draft.channel_id === "longcat" ? "sync-badge warn" : "sync-badge"}>{draft.channel_id === "longcat" ? "手动维护" : "支持同步"}</span>
          </div>
          {draft.channel_id === "longcat" ? (
            <div className="account-resource-grid longcat">
              <label>资源包总量（Tokens）<TextInput type="number" min="0" value={resource.tokenTotal} onChange={(event) => setResource({ ...resource, tokenTotal: event.target.value })} /></label>
              <label>已消耗（Tokens）<TextInput type="number" min="0" value={resource.tokenUsed} onChange={(event) => setResource({ ...resource, tokenUsed: event.target.value })} /></label>
              <label>剩余（Tokens）<TextInput type="number" min="0" value={resource.tokenRemaining} onChange={(event) => setResource({ ...resource, tokenRemaining: event.target.value })} /></label>
              <label>到期时间<TextInput type="datetime-local" value={resource.tokenExpire} onChange={(event) => setResource({ ...resource, tokenExpire: event.target.value })} /></label>
            </div>
          ) : (
            <div className="account-resource-grid">
              <label>余额<TextInput type="number" min="0" step="0.01" value={resource.balance} onChange={(event) => setResource({ ...resource, balance: event.target.value })} /></label>
              <label>货币<TextInput value={resource.currency} onChange={(event) => setResource({ ...resource, currency: event.target.value })} /></label>
            </div>
          )}
        </section>

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
