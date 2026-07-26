import { useNavigate } from "react-router-dom";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewAgentAccessCard } from "../../features/agent-access/OverviewAgentAccessCard";
import { OverviewChannelAccountsCard } from "../../features/channel-accounts/OverviewChannelAccountsCard";
import type { AccountManagerRequest } from "../../features/channel-accounts/AccountManagementSideSheet";
import { OverviewExposedModelsCard } from "../../features/exposed-models/OverviewExposedModelsCard";
import styles from "./OverviewGrid.module.css";

type Props = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  balanceSnapshots: AccountBalanceSnapshot[];
  routes: RouteCandidate[];
  baseUrl: string;
  bindConfig?: ProxyBindConfig;
  proxyRunning: boolean;
  hasAccounts: boolean;
  onAccountRequest: (request: AccountManagerRequest) => void;
  busyModelId?: string;
  onToggleModel: (routeIds: string[], modelId: string, enabled: boolean) => void;
  onboarding: React.ReactNode;
};

export function OverviewGrid({
  accounts,
  channels,
  balanceSnapshots,
  routes,
  baseUrl,
  bindConfig,
  proxyRunning,
  hasAccounts,
  onAccountRequest,
  busyModelId,
  onToggleModel,
  onboarding,
}: Props) {
  const navigate = useNavigate();

  if (!hasAccounts) {
    return <div className={styles.onboarding}>{onboarding}</div>;
  }

  return (
    <div className={styles.grid}>
      <div className={styles.accountCard}>
        <OverviewChannelAccountsCard
          accounts={accounts}
          snapshots={balanceSnapshots}
          onCreate={() => onAccountRequest({ kind: "create", channelId: "longcat" })}
          onViewAll={() => onAccountRequest({ kind: "list" })}
          onEdit={(accountId) => onAccountRequest({ kind: "edit", accountId })}
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
