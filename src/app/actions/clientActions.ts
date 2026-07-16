import { ClientConfig, createClient } from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createClientActions({ data, setMessage }: ActionContext) {
  const { clients, setClients } = data;

  async function saveClientTokens() {
    const filtered = clients.filter((c) => c.name.trim() && c.token.trim());
    await runCommand("save_clients", { clients: filtered });
    setClients(filtered);
    setMessage("客户端 Token 已保存");
  }

  function addClient() {
    setClients((current) => [...current, createClient(current.length)]);
  }

  function updateClient(index: number, patch: Partial<ClientConfig>) {
    setClients((current) =>
      current.map((c, i) => (i === index ? { ...c, ...patch, updated_at: new Date().toISOString() } : c))
    );
  }

  function removeClient(index: number) {
    setClients((current) => current.filter((_, i) => i !== index));
  }

  return { saveClientTokens, addClient, updateClient, removeClient };
}
