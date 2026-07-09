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

function parseToken(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

export function BalanceSnapshotEditor({ account, initialSnapshot, onCancel, onSave }: BalanceSnapshotEditorProps) {
  const isLongCatSnapshot = account.channel_id === "longcat";
  const [balance, setBalance] = React.useState(initialSnapshot?.balance?.toString() ?? "");
  const [currency, setCurrency] = React.useState(initialSnapshot?.currency ?? "CNY");
  const [tokenTotal, setTokenTotalValue] = React.useState(initialSnapshot?.token_pack_total?.toString() ?? "");
  const [tokenUsed, setTokenUsedValue] = React.useState(initialSnapshot?.token_pack_used?.toString() ?? "");
  const [tokenRemaining, setTokenRemainingValue] = React.useState(initialSnapshot?.token_pack_remaining?.toString() ?? "");
  const [tokenExpire, setTokenExpire] = React.useState(initialSnapshot?.token_pack_expire_at ?? "");
  const [remark, setRemark] = React.useState(initialSnapshot?.remark ?? "");

  function setTokenTotal(value: string) {
    setTokenTotalValue(value);
    const total = parseToken(value);
    const used = parseToken(tokenUsed);
    const remaining = parseToken(tokenRemaining);
    if (total == null) return;
    if (used != null) setTokenRemainingValue(Math.max(0, total - used).toString());
    else if (remaining != null) setTokenUsedValue(Math.max(0, total - remaining).toString());
  }

  function setTokenUsed(value: string) {
    setTokenUsedValue(value);
    const total = parseToken(tokenTotal);
    const used = parseToken(value);
    if (total != null && used != null) setTokenRemainingValue(Math.max(0, total - used).toString());
  }

  function setTokenRemaining(value: string) {
    setTokenRemainingValue(value);
    const total = parseToken(tokenTotal);
    const remaining = parseToken(value);
    if (total != null && remaining != null) setTokenUsedValue(Math.max(0, total - remaining).toString());
  }

  function saveSnapshot() {
    const balanceValue = balance.trim() ? Number(balance) : null;
    const total = tokenTotal.trim() ? Number(tokenTotal) : null;
    const used = tokenUsed.trim() ? Number(tokenUsed) : null;
    const remaining = tokenRemaining.trim() ? Number(tokenRemaining) : null;
    if (
      [total, used, remaining].some((value) => value != null && value < 0) ||
      (total != null && used != null && used > total) ||
      (total != null && remaining != null && remaining > total)
    ) {
      return;
    }
    onSave({
      account_id: account.id,
      balance: isLongCatSnapshot ? null : balanceValue,
      currency: isLongCatSnapshot ? null : currency.trim() || null,
      token_pack_total: isLongCatSnapshot ? total : null,
      token_pack_used: isLongCatSnapshot ? used : null,
      token_pack_remaining: isLongCatSnapshot ? remaining : null,
      token_pack_expire_at: isLongCatSnapshot ? tokenExpire || null : null,
      source: "manual",
      synced_at: new Date().toISOString(),
      remark: remark.trim() || null,
    });
  }

  return (
    <Panel>
      <PanelHeader>
        <h3>{isLongCatSnapshot ? "登记 Token 资源包快照" : "登记余额快照"}</h3>
        <Actions>
          <Button type="button" variant="default" onClick={onCancel}>取消</Button>
        </Actions>
      </PanelHeader>
      <div className="form-grid">
        {!isLongCatSnapshot ? (
          <>
            <TextInput type="number" label="余额数值" min="0" step="0.01" value={balance} placeholder="例如 100.50" onChange={(e) => setBalance(e.target.value)} />
            <TextInput label="货币" value={currency} placeholder="CNY" onChange={(e) => setCurrency(e.target.value)} />
          </>
        ) : null}
        {isLongCatSnapshot ? (
          <>
            <TextInput type="number" label="Token 资源包总量" min="0" value={tokenTotal} placeholder="可选，例如 1000000" onChange={(e) => setTokenTotal(e.target.value)} />
            <TextInput type="number" label="已消耗 Token" min="0" value={tokenUsed} placeholder="例如 250000" onChange={(e) => setTokenUsed(e.target.value)} />
            <TextInput type="number" label="剩余 Token" min="0" value={tokenRemaining} placeholder="例如 750000" onChange={(e) => setTokenRemaining(e.target.value)} />
            <TextInput type="date" label="资源包过期时间" value={tokenExpire} onChange={(e) => setTokenExpire(e.target.value)} />
          </>
        ) : null}
        <TextInput label="备注" value={remark} placeholder="可选备注" onChange={(e) => setRemark(e.target.value)} />
      </div>
      <Actions>
        <Button type="button" onClick={saveSnapshot}>保存快照</Button>
      </Actions>
    </Panel>
  );
}
