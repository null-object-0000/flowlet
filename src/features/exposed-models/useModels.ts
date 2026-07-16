import { useQuery } from "@tanstack/react-query";
import { modelCommands } from "../../domains/model/commands";
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
