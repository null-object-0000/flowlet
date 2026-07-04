import {
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  ClientConfig,
  RouteCandidate,
  RouteRule,
  VirtualModel,
} from "../domain";
import {
  ModelServicesPanel,
  ModelSyncPanel,
  RouteCandidatesPanel,
  RouteRulesPanel,
} from "../features/routes";

type RoutesPageProps = {
  routes: RouteCandidate[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  channelModels: ChannelModel[];
  virtualModels: VirtualModel[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  onSyncModels: (accountId: string) => void;
  onRefreshChannelModels: () => void;
  getChannelName: (channelId: string) => string;
  routeRules: RouteRule[];
  onAddRouteRule: () => void;
  onUpdateRouteRule: (index: number, patch: Partial<RouteRule>) => void;
  onRemoveRouteRule: (index: number) => void;
  onSaveRouteRules: () => void;
  clients: ClientConfig[];
};

export function RoutesPage({
  routes,
  channels,
  accounts,
  channelModels,
  virtualModels,
  onAdd,
  onUpdate,
  onRemove,
  onSave,
  onRegenerateDefaultRoutes,
  onSyncModels,
  onRefreshChannelModels,
  getChannelName,
  routeRules,
  onAddRouteRule,
  onUpdateRouteRule,
  onRemoveRouteRule,
  onSaveRouteRules,
  clients,
}: RoutesPageProps) {
  return (
    <>
      <ModelServicesPanel
        routes={routes}
        accounts={accounts}
        onUpdate={onUpdate}
        onSave={onSave}
        onRegenerateDefaultRoutes={onRegenerateDefaultRoutes}
        getChannelName={getChannelName}
      />
      <ModelSyncPanel
        channels={channels}
        accounts={accounts}
        channelModels={channelModels}
        onSyncModels={onSyncModels}
        onRefreshChannelModels={onRefreshChannelModels}
        getChannelName={getChannelName}
      />
      <RouteCandidatesPanel
        routes={routes}
        channels={channels}
        accounts={accounts}
        virtualModels={virtualModels}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onSave={onSave}
      />
      <RouteRulesPanel
        routeRules={routeRules}
        channels={channels}
        accounts={accounts}
        clients={clients}
        onAddRouteRule={onAddRouteRule}
        onUpdateRouteRule={onUpdateRouteRule}
        onRemoveRouteRule={onRemoveRouteRule}
        onSaveRouteRules={onSaveRouteRules}
      />
    </>
  );
}
