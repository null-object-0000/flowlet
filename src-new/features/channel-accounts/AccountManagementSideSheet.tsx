import { useMemo, useState } from "react";
import { Button, Input, Modal, SideSheet, Space, Switch, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconMore, IconPlus, IconSearch } from "@douyinfe/semi-icons";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { AccountEditorDrawer, type AccountEditorMode, type AccountResourceSnapshotDraft } from "./AccountEditorDrawer";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./AccountManagementSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

export type AccountManagerRequest =
  | { kind: "list" }
  | { kind: "create"; channelId: string }
  | { kind: "edit"; accountId: string };

type TestInput = { channel_id: string; api_key: string; base_url_override?: string | null };
type Props = {
  request: AccountManagerRequest | null;
  accounts: ChannelAccount[];
  snapshots: AccountBalanceSnapshot[];
  presets: ChannelPreset[];
  busy: boolean;
  onClose: () => void;
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void>;
  onTestConnection: (input: TestInput) => Promise<void>;
  onSaveBalanceSnapshot: (snapshot: AccountBalanceSnapshot) => Promise<void>;
  onSyncBalance: (accountId: string) => Promise<void>;
};

export function AccountManagementSideSheet(props: Props) {
  const { language, t } = useAppPreferences();
  const { request, accounts, snapshots, presets, busy, onClose, onSaveAccounts, onTestConnection, onSaveBalanceSnapshot, onSyncBalance } = props;
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<AccountEditorMode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChannelAccount | null>(null);
  const snapshotByAccount = useMemo(() => new Map(snapshots.map((item) => [item.account_id, item])), [snapshots]);
  const channelName = useMemo(() => new Map(presets.map((item) => [item.id, item.name])), [presets]);
  const requestedEditor = resolveRequestedEditor(request, accounts, presets);
  const activeEditor = request?.kind === "list" ? editor : requestedEditor;

  const filtered = accounts.filter((account) => {
    const keyword = search.trim().toLowerCase();
    return !keyword
      || account.name.toLowerCase().includes(keyword)
      || account.channel_id.toLowerCase().includes(keyword)
      || channelName.get(account.channel_id)?.toLowerCase().includes(keyword);
  });

  const save = async (next: ChannelAccount[], message: string) => {
    try {
      await onSaveAccounts(next);
      Toast.success(message);
      return true;
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  };

  const closeEditor = () => {
    if (request?.kind === "list") setEditor(null);
    else onClose();
  };

  const closeManager = () => {
    setSearch("");
    setEditor(null);
    onClose();
  };

  const saveEditor = async (account: ChannelAccount, snapshot: AccountResourceSnapshotDraft | null) => {
    const previous = accounts.find((item) => item.id === account.id);
    const normalized = previous && !account.api_key.trim() ? { ...account, api_key: previous.api_key } : account;
    const nextAccounts = previous ? accounts.map((item) => item.id === normalized.id ? normalized : item) : [...accounts, normalized];
    try {
      await onSaveAccounts(nextAccounts);
      if (snapshot) {
        const now = new Date().toISOString();
        await onSaveBalanceSnapshot({ ...snapshot, id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, created_at: now, updated_at: now });
      }
      Toast.success(t("渠道账号与资源信息已保存，代理配置已热更新"));
      closeEditor();
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const toggle = async (account: ChannelAccount, enabled: boolean) => {
    await save(accounts.map((item) => item.id === account.id ? { ...item, enabled } : item), t(enabled ? "账号已启用" : "账号已停用"));
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const saved = await save(accounts.filter((item) => item.id !== deleteTarget.id), t("账号已删除"));
    if (saved) setDeleteTarget(null);
  };

  return (
    <>
      {request?.kind === "list" && editor == null ? <SideSheet
        visible
        motion={false}
        zIndex={1100}
        title={<div><strong>{t("渠道账号管理")}</strong><small>{t("共 {total} 个账号，{enabled} 个已启用", { total: accounts.length, enabled: accounts.filter((item) => item.enabled).length })}</small></div>}
        width="min(720px, 94vw)"
        footer={(
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={closeManager}>{t("关闭")}</Button>
            <Button icon={<IconPlus />} type="primary" theme="solid" disabled={!presets[0]} onClick={() => presets[0] && setEditor({ kind: "create", channelId: presets[0].id })}>{t("新增账号")}</Button>
          </Space>
        )}
        onCancel={closeManager}
      >
        <div className={styles.body}>
          <div className={styles.toolbar}>
            <Input prefix={<IconSearch />} value={search} onChange={setSearch} placeholder={t("搜索账号名称或渠道")} aria-label={t("搜索账号")} />
            <Text type="tertiary">{t("共 {count} 条", { count: filtered.length })}</Text>
          </div>
          <div className={styles.list}>
            {filtered.length === 0 ? <div className={styles.empty}>{accounts.length ? t("没有匹配“{search}”的账号", { search }) : t("还没有配置渠道账号")}</div> : null}
            {filtered.map((account) => {
              const status = getStatus(account, t);
              return (
                <div className={styles.row} key={account.id}>
                  <button type="button" className={styles.main} onClick={() => setEditor({ kind: "edit", account })}>
                    <ChannelBrandLogo channelId={account.channel_id} name={account.name} />
                    <span className={styles.name}><strong>{account.name}</strong><small>{channelName.get(account.channel_id) ?? account.channel_id}</small></span>
                    <span className={styles.metrics}>{resourceDetails(account, snapshotByAccount.get(account.id), t, language).map((item) => <span key={item.label}><em>{item.label}</em><b>{item.value}</b></span>)}</span>
                  </button>
                  <Tag color={status.color}>{status.label}</Tag>
                  <Switch checked={account.enabled} disabled={busy} aria-label={t(account.enabled ? "停用账号 {name}" : "启用账号 {name}", { name: account.name })} onChange={(checked) => void toggle(account, checked)} />
                  <Button icon={<IconMore />} theme="borderless" aria-label={t("编辑账号 {name}", { name: account.name })} onClick={() => setEditor({ kind: "edit", account })} />
                  <Button icon={<IconDelete />} theme="borderless" type="danger" aria-label={t("删除账号 {name}", { name: account.name })} onClick={() => setDeleteTarget(account)} />
                </div>
              );
            })}
          </div>
        </div>
      </SideSheet> : null}

      {activeEditor ? <AccountEditorDrawer
        key={activeEditor.kind === "create" ? `create:${activeEditor.channelId}` : `edit:${activeEditor.account.id}`}
        mode={activeEditor}
        accounts={accounts}
        presets={presets}
        snapshot={activeEditor.kind === "edit" ? snapshotByAccount.get(activeEditor.account.id) : undefined}
        onClose={closeEditor}
        onSave={saveEditor}
        onTestConnection={onTestConnection}
        onSyncBalance={onSyncBalance}
      /> : null}
      <Modal title={t("确认删除账号")} visible={deleteTarget != null} zIndex={1200} footer={null} onCancel={() => setDeleteTarget(null)}>
        <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
          <Text>{t("确定要删除账号“{name}”吗？删除后将退出所有路由，且无法恢复。", { name: deleteTarget?.name ?? "" })}</Text>
          <Space style={{ justifyContent: "flex-end", width: "100%" }}><Button onClick={() => setDeleteTarget(null)}>{t("取消")}</Button><Button type="danger" theme="solid" loading={busy} onClick={() => void remove()}>{t("确认删除")}</Button></Space>
        </Space>
      </Modal>
    </>
  );
}

function resolveRequestedEditor(
  request: AccountManagerRequest | null,
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
): AccountEditorMode | null {
  if (!request || request.kind === "list") return null;
  if (request.kind === "create") {
    return presets.some((item) => item.id === request.channelId)
      ? { kind: "create", channelId: request.channelId }
      : null;
  }
  const account = accounts.find((item) => item.id === request.accountId);
  return account ? { kind: "edit", account } : null;
}

function getStatus(account: ChannelAccount, t: (source: string) => string): { label: string; color: "green" | "red" | "grey" } {
  if (!account.enabled) return { label: t("停用"), color: "grey" };
  if (account.credential_status === "invalid_key") return { label: t("无效"), color: "red" };
  return { label: t("启用"), color: "green" };
}

function resourceDetails(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string) => string, language: "zh-CN" | "en-US") {
  const tokenPack = (account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack";
  if (!tokenPack) return [{ label: t("余额"), value: snapshot?.balance == null ? "-" : `${snapshot.balance} ${snapshot.currency ?? ""}`.trim() }];
  const rows = [{ label: t("剩余"), value: snapshot?.token_pack_remaining == null ? "-" : `${formatToken(snapshot.token_pack_remaining, language)} Tokens` }];
  if (snapshot?.token_pack_expire_at) rows.push({ label: t("有效期"), value: snapshot.token_pack_expire_at.split("T")[0] });
  return rows;
}

function formatToken(value: number, language: "zh-CN" | "en-US") {
  if (language === "en-US") return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}
