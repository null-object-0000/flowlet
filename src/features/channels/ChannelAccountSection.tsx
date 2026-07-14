import React from "react";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";
import { AccountEditorRequest } from "./AccountEditorDrawer";
import { AccountManagementDrawer } from "./AccountManagementDrawer";
import { ChannelAccountsPanel } from "./ChannelAccountsPanel";

type ChannelAccountSectionProps = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  getChannelName: (channelId: string) => string;
  onCreateAccount: () => void;
  onEditAccount: (index: number) => void;
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void> | void;
  onTestConnection: (channelId: string, apiKey: string, baseUrlOverride?: string | null) => void;
  onSyncBalance: (accountId: string) => void;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  onOpenEditor: (request: AccountEditorRequest) => void;
};

export function ChannelAccountSection({
  accounts,
  channels,
  getBalanceForAccount,
  getChannelName,
  onCreateAccount,
  onEditAccount,
  onSaveAccounts,
  onTestConnection,
  onSyncBalance,
  onAddBalanceSnapshot,
  onOpenEditor,
}: ChannelAccountSectionProps) {
  const [managementDrawer, setManagementDrawer] = React.useState<{ opened: boolean; focusIndex: number | null }>({ opened: false, focusIndex: null });

  return (
    <>
      <ChannelAccountsPanel
        accounts={accounts}
        channels={channels}
        getBalanceForAccount={getBalanceForAccount}
        getChannelName={getChannelName}
        onCreateAccount={onCreateAccount}
        onOpenManagementDrawer={(focusIndex) => setManagementDrawer({ opened: true, focusIndex: focusIndex ?? null })}
        onEditAccount={onEditAccount}
      />
      <AccountManagementDrawer
        opened={managementDrawer.opened}
        onClose={() => setManagementDrawer({ opened: false, focusIndex: null })}
        accounts={accounts}
        channels={channels}
        onSaveAccounts={onSaveAccounts}
        onTestConnection={onTestConnection}
        onSyncBalance={onSyncBalance}
        getBalanceForAccount={getBalanceForAccount}
        onAddBalanceSnapshot={onAddBalanceSnapshot}
        onOpenEditor={(request) => {
          setManagementDrawer({ opened: false, focusIndex: null });
          onOpenEditor(request);
        }}
      />
    </>
  );
}
