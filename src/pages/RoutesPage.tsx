import {
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  RouteCandidate,
  RouteRule,
  VirtualModel,
} from "../domain";
import { ModelServicesPanel, RouteCandidatesPanel, RouteRulesPanel } from "../features/routes";

type RoutesPageProps = {
  routes: RouteCandidate[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  virtualModels: VirtualModel[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
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
  virtualModels,
  onAdd,
  onUpdate,
  onRemove,
  onSave,
  onRegenerateDefaultRoutes,
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
