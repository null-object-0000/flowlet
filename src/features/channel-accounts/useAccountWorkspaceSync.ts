import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountWorkspaceCommands } from "../../domains/account-workspace/commands";
import { queryKeys } from "../../shared/query-keys";

export function useAccountWorkspaceSync() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: queryKeys.accountWorkspace.status(), queryFn: accountWorkspaceCommands.status });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.accountWorkspace.status() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.account.list() }),
    ]);
  };
  const initialize = useMutation({ mutationFn: accountWorkspaceCommands.initialize, onSuccess: refresh });
  const sync = useMutation({ mutationFn: accountWorkspaceCommands.sync, onSuccess: refresh });
  const exportDesktopPackage = useMutation({ mutationFn: accountWorkspaceCommands.exportDesktopPackage });
  const importDesktopPackage = useMutation({ mutationFn: accountWorkspaceCommands.importDesktopPackage, onSuccess: refresh });
  return { status, initialize, sync, exportDesktopPackage, importDesktopPackage };
}
