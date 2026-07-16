import React from "react";
import { Button, TextInput } from "@mantine/core";
import { Actions, Panel, PanelHeader } from "../../components/ui";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";

type BalanceSnapshotEditorProps = {
  account: ChannelAccount;
  channel?: ChannelPreset;
  initialSnapshot?: AccountBalanceSnapshot;
  onCancel: () => void;
  onSave: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
};

export function BalanceSnapshotEditor({ account, channel, initialSnapshot, onCancel, onSave }: BalanceSnapshotEditorProps) {
  const autoSync = channel?.supports_balance_query === true;
  const [balance, setBalance] = React.useState(initialSnapshot?.balance?.toString() ?? "");
  const [currency, setCurrency] = React.useState(initialSnapshot?.currency ?? "CNY");
  const [remark, setRemark] = React.useState(initialSnapshot?.remark ?? "");

  function saveSnapshot() {
    const balanceValue = balance.trim() ? Number(balance) : null;
    onSave({
      account_id: account.id,
      balance: balanceValue,
      currency: currency.trim() || null,
      token_pack_total: null,
      token_pack_used: null,
      token_pack_remaining: null,
      token_pack_expire_at: null,
      source: "manual",
      synced_at: new Date().toISOString(),
      remark: remark.trim() || null,
    });
  }

  return (
    <Panel>
      <PanelHeader>
        <h3>登记余额快照</h3>
        <Actions>
          <Button type="button" variant="default" onClick={onCancel}>取消</Button>
        </Actions>
      </PanelHeader>
      {autoSync ? (
        <div className="form-grid">
          <p className="hint-text">该渠道支持余额自动同步，不支持手动登记余额快照。保存账号后系统会自动从上游获取余额信息。</p>
          <TextInput label="备注" value={remark} placeholder="可选备注" onChange={(e) => setRemark(e.target.value)} />
        </div>
      ) : (
        <div className="form-grid">
          <TextInput type="number" label="余额数值" min="0" step="0.01" value={balance} placeholder="例如 100.50" onChange={(e) => setBalance(e.target.value)} />
          <TextInput label="货币" value={currency} placeholder="CNY" onChange={(e) => setCurrency(e.target.value)} />
          <TextInput label="备注" value={remark} placeholder="可选备注" onChange={(e) => setRemark(e.target.value)} />
        </div>
      )}
      <Actions>
        <Button type="button" onClick={saveSnapshot} disabled={autoSync}>保存快照</Button>
      </Actions>
    </Panel>
  );
}
