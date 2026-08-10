import { useNavigate } from "react-router-dom";
import { OverviewGridView } from "@flowlet/product-ui";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewAgentAccessCard } from "../../features/agent-access/OverviewAgentAccessCard";
import { OverviewChannelAccountsCard } from "../../features/channel-accounts/OverviewChannelAccountsCard";
import type { AccountActionRequest } from "../../features/channel-accounts/AccountActionOverlay";
import { OverviewExposedModelsCard } from "../../features/exposed-models/OverviewExposedModelsCard";

type Props = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  balanceSnapshots: AccountBalanceSnapshot[];
  codexAccounts?: CodexAccountReport[];
  routes: RouteCandidate[];
  baseUrl: string;
  bindConfig?: ProxyBindConfig;
  onAccountRequest: (request: AccountActionRequest) => void;
  onToggleAccount: (accountId: string, enabled: boolean) => void;
  accountActionBusy?: boolean;
  onOpenCodexAgent?: (accountId: string) => void;
};

export function OverviewGrid({
  accounts,
  channels,
  balanceSnapshots,
  codexAccounts,
  routes,
  baseUrl,
  bindConfig,
  onAccountRequest,
  onToggleAccount,
  accountActionBusy,
  onOpenCodexAgent,
}: Props) {
  const navigate = useNavigate();

  return (
    <OverviewGridView
      accounts={<OverviewChannelAccountsCard
          accounts={accounts}
          channels={channels}
          snapshots={balanceSnapshots}
          codexAccounts={codexAccounts}
          onCreate={(channelId) => onAccountRequest({ kind: "create", channelId })}
          onEdit={(accountId) => onAccountRequest({ kind: "edit", accountId })}
          onToggle={onToggleAccount}
          onDelete={(accountId) => onAccountRequest({ kind: "delete", accountId })}
          onOpenCodexAgent={onOpenCodexAgent}
          busy={accountActionBusy}
        />}
      models={<OverviewExposedModelsCard
          routes={routes}
          accounts={accounts}
          channels={channels}
          onManage={() => navigate("/models")}
        />}
      agents={<OverviewAgentAccessCard baseUrl={baseUrl} clientToken={bindConfig?.default_client_token} />}
    />
  );
}
