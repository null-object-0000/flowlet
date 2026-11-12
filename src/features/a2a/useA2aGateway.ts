import { newA2aId } from "../../domains/a2a/identity";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import { a2aCommands } from "../../domains/a2a/commands";
import type { A2aAgent, A2aAgentInput, A2aCall } from "../../domains/a2a/types";
import { errorMessage } from "../../shared/errors/AppError";
const report = (error: unknown) => Toast.error(errorMessage(error));
export function useA2aGateway() {
  const qc = useQueryClient();
  const agents = useQuery({
    queryKey: ["a2a", "agents"],
    queryFn: a2aCommands.list,
  });
  const keys = useQuery({
    queryKey: ["a2a", "keys"],
    queryFn: a2aCommands.keys,
  });
  const [filter, setFilter] = useState<string>();
  const calls = useQuery({
    queryKey: ["a2a", "calls", filter],
    queryFn: () => a2aCommands.calls(filter),
    refetchInterval: 10000,
  });
  const [draft, setDraft] = useState<A2aAgentInput | null>(null);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<unknown>(null);
  const [keyName, setKeyName] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [newToken, setNewToken] = useState("");
  const [selected, setSelected] = useState<A2aAgent | null>(null);
  const [message, setMessage] = useState("");
  const [contextId, setContextId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [callDetail, setCallDetail] = useState<A2aCall | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["a2a"] });
  const save = useMutation({
    mutationFn: a2aCommands.save,
    onSuccess: async () => {
      setDraft(null);
      setPreview(null);
      await refresh();
      Toast.success("Agent 已保存");
    },
    onError: report,
  });
  const inspect = useMutation({
    mutationFn: a2aCommands.inspect,
    onSuccess: setPreview,
    onError: report,
  });
  const remove = useMutation({
    mutationFn: a2aCommands.remove,
    onSuccess: refresh,
    onError: report,
  });
  const createKey = useMutation({
    mutationFn: () => a2aCommands.createKey(keyName, grants),
    onSuccess: async (value) => {
      setNewToken(value.token);
      setKeyName("");
      await refresh();
    },
    onError: report,
  });
  const revoke = useMutation({
    mutationFn: a2aCommands.revokeKey,
    onSuccess: refresh,
    onError: report,
  });
  const invoke = useMutation({
    mutationFn: (rpc: unknown) =>
      a2aCommands.invoke(selected!.id, rpc, selected!.timeoutSeconds),
    onSuccess: async (value) => {
      setResult(value);
      const body = value.body as {
        result?: { task?: { id?: string; contextId?: string } };
      } | null;
      const task = body?.result?.task;
      if (typeof task?.id === "string") setTaskId(task.id);
      if (typeof task?.contextId === "string") setContextId(task.contextId);
      await qc.invalidateQueries({ queryKey: ["a2a", "calls"] });
    },
    onError: report,
  });
  const rpc = (method: string) => ({
    jsonrpc: "2.0",
    id: newA2aId(),
    method,
    params: {
      ...(() => {
        const iface = selected?.card.supportedInterfaces?.find(
          (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
        );
        return iface?.tenant ? { tenant: iface.tenant } : {};
      })(),
      ...(method === "SendMessage"
        ? {
            message: {
              messageId: newA2aId(),
              role: "ROLE_USER",
              parts: [{ text: message }],
              ...(contextId ? { contextId } : {}),
            },
          }
        : method === "ListTasks"
          ? { ...(contextId ? { contextId } : {}) }
          : { id: taskId }),
    },
  });

  return {
    agents,
    keys,
    filter,
    setFilter,
    calls,
    draft,
    setDraft,
    editing,
    setEditing,
    preview,
    setPreview,
    keyName,
    setKeyName,
    grants,
    setGrants,
    newToken,
    setNewToken,
    selected,
    setSelected,
    message,
    setMessage,
    contextId,
    setContextId,
    taskId,
    setTaskId,
    result,
    setResult,
    callDetail,
    setCallDetail,
    refresh,
    save,
    inspect,
    remove,
    createKey,
    revoke,
    invoke,
    rpc,
  };
}
export type A2aGatewayState = ReturnType<typeof useA2aGateway>;
