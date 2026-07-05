import { Actions, Panel, PanelHeader } from "../components/ui";
import { ClientConfig } from "../domain";

export function ClientsPage({
  clients,
  onAdd,
  onUpdate,
  onRemove,
  onSave,
  onCopy,
}: {
  clients: ClientConfig[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<ClientConfig>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onCopy: (text: string, done: string) => Promise<void>;
}) {
  return (
    <Panel>
      <PanelHeader>
        <h3>客户端 Token</h3>
        <Actions>
          <button type="button" onClick={onAdd}>新增客户端</button>
          <button type="button" onClick={() => void onSave()}>保存 Token</button>
        </Actions>
      </PanelHeader>
      <div className="client-list">
        {clients.length === 0 ? (
          <p>暂无客户端 Token</p>
        ) : (
          clients.map((client, index) => (
            <div className="client-row" key={client.id}>
              <input value={client.name} placeholder="客户端名称" onChange={(e) => onUpdate(index, { name: e.target.value })} />
              <input value={client.token} placeholder="Client Token" onChange={(e) => onUpdate(index, { token: e.target.value })} />
              <select value={client.app_type} onChange={(e) => onUpdate(index, { app_type: e.target.value })}>
                <option value="local">本机</option>
                <option value="claude-code">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="cline">Cline</option>
                <option value="open-webui">Open WebUI</option>
                <option value="cherry-studio">Cherry Studio</option>
                <option value="continue">Continue</option>
                <option value="custom">自定义</option>
              </select>
              <button type="button" onClick={() => void onCopy(`Bearer ${client.token}`, "Client Token 已复制")}>复制</button>
              <button type="button" onClick={() => onRemove(index)}>删除</button>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
