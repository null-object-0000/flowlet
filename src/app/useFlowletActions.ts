import {
  createChannelActions,
  createClientActions,
  createConfigActions,
  createProxyActions,
  createRouteActions,
  createUsageActions,
} from "./actions";
import { SetMessage, FlowletData } from "./actions/types";

export function useFlowletActions(data: FlowletData, setMessage: SetMessage) {
  const context = { data, setMessage };

  return {
    ...createProxyActions(context),
    ...createConfigActions(context),
    ...createChannelActions(context),
    ...createClientActions(context),
    ...createRouteActions(context),
    ...createUsageActions(context),
  };
}
