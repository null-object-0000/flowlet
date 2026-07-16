import { useNavigate } from "react-router-dom";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewAgentAccessCard } from "../../features/agent-access/OverviewAgentAccessCard";
import { OverviewChannelAccountsCard } from "../../features/channel-accounts/OverviewChannelAccountsCard";
import type { AccountManagerRequest } from "../../features/channel-accounts/AccountManagementSideSheet";
import { OverviewClientAccessCard } from "../../features/client-access/OverviewClientAccessCard";
import { OverviewExposedModelsCard } from "../../features/exposed-models/OverviewExposedModelsCard";
import styles from "./OverviewSections.module.css";

type Props = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  balanceSnapshots: AccountBalanceSnapshot[];
  routes: RouteCandidate[];
  baseUrl: string;
  bindConfig: ProxyBindConfig;
  proxyRunning: boolean;
  onAccountRequest: (request: AccountManagerRequest) => void;
  busyModelId?: string;
  onToggleModel: (routeIds: string[], modelId: string, enabled: boolean) => void;
};

export function OverviewSections({ accounts, channels, balanceSnapshots, routes, baseUrl, bindConfig, proxyRunning, onAccountRequest, busyModelId, onToggleModel }: Props) {
  const navigate = useNavigate();

  return (
    <div className={styles.sections}>
      <div className={`${styles.grid} ${styles.primary}`}>
        <OverviewChannelAccountsCard
          accounts={accounts}
          snapshots={balanceSnapshots}
          onCreate={() => onAccountRequest({ kind: "create", channelId: "longcat" })}
          onViewAll={() => onAccountRequest({ kind: "list" })}
          onEdit={(accountId) => onAccountRequest({ kind: "edit", accountId })}
        />
        <OverviewExposedModelsCard
          routes={routes}
          accounts={accounts}
          channels={channels}
          busyModelId={busyModelId}
          onManage={() => navigate("/models")}
          onToggle={onToggleModel}
        />
      </div>
      <div className={`${styles.grid} ${styles.secondary}`}>
        <OverviewClientAccessCard
          baseUrl={baseUrl}
          bindConfig={bindConfig}
          running={proxyRunning}
        />
        <OverviewAgentAccessCard
          baseUrl={baseUrl}
          clientToken={bindConfig.default_client_token}
        />
      </div>
    </div>
  );
}
