import { useNavigate } from "react-router-dom";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewAgentAccessCard } from "../../features/agent-access/OverviewAgentAccessCard";
import { OverviewChannelAccountsCard } from "../../features/channel-accounts/OverviewChannelAccountsCard";
import type { AccountActionRequest } from "../../features/channel-accounts/AccountActionOverlay";
import { OverviewExposedModelsCard } from "../../features/exposed-models/OverviewExposedModelsCard";
import styles from "./OverviewGrid.module.css";

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
  busyModelId?: string;
  onToggleModel: (routeIds: string[], modelId: string, enabled: boolean) => void;
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
  busyModelId,
  onToggleModel,
}: Props) {
  const navigate = useNavigate();

  return (
    <div className={styles.grid}>
      <div className={styles.accountCard}>
        <OverviewChannelAccountsCard
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
        />
      </div>
      <div className={styles.modelsCard}>
        <OverviewExposedModelsCard
          routes={routes}
          accounts={accounts}
          channels={channels}
          busyModelId={busyModelId}
          onManage={() => navigate("/models")}
          onToggle={onToggleModel}
        />
      </div>
      <div className={styles.agentCard}>
        <OverviewAgentAccessCard baseUrl={baseUrl} clientToken={bindConfig?.default_client_token} />
      </div>
    </div>
  );
}
