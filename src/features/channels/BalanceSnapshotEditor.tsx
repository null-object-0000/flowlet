import React from "react";
import { Button, TextInput } from "@mantine/core";
import { Actions, Panel, PanelHeader } from "../../components/ui";
import { AccountBalanceSnapshot, ChannelAccount } from "../../domain";

type BalanceSnapshotEditorProps = {
  account: ChannelAccount;
  initialSnapshot?: AccountBalanceSnapshot;
  onCancel: () => void;
  onSave: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
};

export function BalanceSnapshotEditor({ account, initialSnapshot, onCancel, onSave }: BalanceSnapshotEditorProps) {
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
      <div className="form-grid">
        <TextInput type="number" label="余额数值" min="0" step="0.01" value={balance} placeholder="例如 100.50" onChange={(e) => setBalance(e.target.value)} />
        <TextInput label="货币" value={currency} placeholder="CNY" onChange={(e) => setCurrency(e.target.value)} />
        <TextInput label="备注" value={remark} placeholder="可选备注" onChange={(e) => setRemark(e.target.value)} />
      </div>
      <Actions>
        <Button type="button" onClick={saveSnapshot}>保存快照</Button>
      </Actions>
    </Panel>
  );
}
