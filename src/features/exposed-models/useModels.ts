import { useQuery } from "@tanstack/react-query";
import { modelCommands } from "../../domains/model/commands";
import { getModelPrices } from "../../domains/settings/commands";
import { queryKeys } from "../../shared/query-keys";

export function useChannelModels() {
  return useQuery({
    queryKey: queryKeys.model.channelModels(),
    queryFn: () => modelCommands.listChannelModels(),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useRouteCandidates() {
  return useQuery({
    queryKey: queryKeys.model.candidates(),
    queryFn: () => modelCommands.listRouteCandidates(),

    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useModelExposureMode() {
  return useQuery({
    queryKey: queryKeys.model.exposureMode(),
    queryFn: () => modelCommands.readExposureMode(),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** config.json `channels_config.model_prices` 的完整定价表。价格仅用于模型
 *  服务页展示，加载失败时页面降级为“—”而不阻塞，故 retry 保守、不进页面级
 *  error 聚合。数据随 config.json 热加载语义一致（价格变更需重启代理）。 */
export function useModelPrices() {
  return useQuery({
    queryKey: queryKeys.settings.modelPrices(),
    queryFn: getModelPrices,
    staleTime: 5 * 60 * 1000,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
