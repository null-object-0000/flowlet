import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useChannelPresets } from "../../features/channel-accounts/useChannelPresets";
import { useAccounts, useAccountActions } from "../../features/channel-accounts";
import { AccountList } from "../../features/channel-accounts/AccountList";
import { AccountEditorDrawer } from "../../features/channel-accounts/AccountEditorDrawer";
import type { AccountEditorMode } from "../../features/channel-accounts/AccountEditorDrawer";
import type { ChannelAccount } from "../../domains/account/types";
import { newAccount } from "../../domains/account/types";
import { AccountOnboarding } from "../../features/channel-accounts/AccountOnboarding";
import styles from "./ChannelsPage.module.css";

/**
 * Channels & accounts page. Owns the local draft list (add/remove/edit in
 * memory) and only persists on explicit save. Gating follows AGENTS.md §4/§7:
 * this page manages the raw account lifecycle; the overview page decides the
 * unconfigured/no_models/ready model service status separately.
 */
export function ChannelsPage() {
  const navigate = useNavigate();
  const presets = useChannelPresets();
  const accountsQuery = useAccounts();
  const { saveAll, testConnection } = useAccountActions();

  const [drafts, setDrafts] = useState<ChannelAccount[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; mode: AccountEditorMode | null }>({
    open: false,
    mode: null,
  });
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const loaded = accountsQuery.data ?? [];
  // Use drafts once the user has made edits; otherwise reflect the loaded list.
  const accounts = dirty ? drafts : loaded;

  const addAccount = (channelId: string) => {
    const count = accounts.filter((a) => a.channel_id === channelId).length;
    setDrafts((prev) => [...prev, ...(dirty ? [] : accounts), newAccount(channelId, count)]);
    setDirty(true);
    setEditor({ open: true, mode: { kind: "create", channelId } });
  };

  const editAccount = (accountId: string) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    if (!dirty) setDrafts(accounts); // snapshot for edit
    setDirty(true);
    setEditor({ open: true, mode: { kind: "edit", account: acc } });
  };

  const removeAccount = (accountId: string) => {
    if (!dirty) setDrafts(accounts);
    setDrafts((prev) => prev.filter((a) => a.id !== accountId));
    setDirty(true);
  };

  const onEditorSave = async (account: ChannelAccount) => {
    setDrafts((prev) => {
      const idx = prev.findIndex((a) => a.id === account.id);
      if (idx === -1) return [...prev, account];
      const next = [...prev];
      next[idx] = account;
      return next;
    });
    setDirty(true);
    setEditor({ open: false, mode: null });
  };

  const onTestConnection = async (input: {
    channel_id: string;
    api_key: string;
    base_url_override?: string | null;
  }) => {
    if (!input.api_key.trim()) {
      setNotice({ kind: "err", msg: "请先填写 API Key" });
      return;
    }
    setNotice(null);
    await testConnection.mutateAsync(input);
    setNotice({ kind: "ok", msg: "连接成功！API Key 有效" });
  };

  const persist = async () => {
    setSaving(true);
    setNotice(null);
    await saveAll.mutateAsync(accounts);
    setSaving(false);
    setDirty(false);
    setNotice({ kind: "ok", msg: "渠道账号已保存，代理配置已热更新" });
  };

  if (presets.isLoading || accountsQuery.isLoading) {
    return <div className={styles.page}>正在加载渠道配置…</div>;
  }
  if (presets.isError) {
    return <div className={styles.page}>加载渠道失败：{presets.error.message}</div>;
  }
  if (accountsQuery.isError) {
    return <div className={styles.page}>加载账号失败：{accountsQuery.error.message}</div>;
  }

  const presetsList = presets.data ?? [];

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h2 className={styles.title}>渠道账号</h2>
        <div className={styles.actions}>
          <button className={styles.linkBtn} onClick={() => navigate("/")}>
            ← 返回概览
          </button>
          <button className={styles.primaryBtn} onClick={persist} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {notice && (
        <div className={notice.kind === "ok" ? styles.noticeOk : styles.noticeErr}>{notice.msg}</div>
      )}

      {accounts.length === 0 ? (
        <AccountOnboarding presets={presetsList} onAdd={addAccount} />
      ) : (
        <AccountList
          presets={presetsList}
          accounts={accounts}
          onAdd={addAccount}
          onEdit={editAccount}
          onTestConnection={(acc) =>
            onTestConnection({ channel_id: acc.channel_id, api_key: acc.api_key, base_url_override: acc.base_url_override })
          }
          onRemove={removeAccount}
          busy={testConnection.isPending}
        />
      )}

      <AccountEditorDrawer
        visible={editor.open}
        mode={editor.mode}
        presets={presetsList}
        onClose={() => setEditor({ open: false, mode: null })}
        onSave={onEditorSave}
        onTestConnection={onTestConnection}
      />
    </main>
  );
}
