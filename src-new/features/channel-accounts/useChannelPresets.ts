import { useQuery } from "@tanstack/react-query";
import { channelCommands } from "../../domains/channel/commands";
import { queryKeys } from "../../shared/query-keys";

export function useChannelPresets() {
  return useQuery({
    queryKey: queryKeys.channel.presets(),
    queryFn: () => channelCommands.listPresets(),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
