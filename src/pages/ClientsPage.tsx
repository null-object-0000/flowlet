import { Button, Select, TextInput } from "@mantine/core";
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
          <Button type="button" variant="default" onClick={onAdd}>新增客户端</Button>
          <Button type="button" onClick={() => void onSave()}>保存 Token</Button>
        </Actions>
      </PanelHeader>
      <div className="client-list">
        {clients.length === 0 ? (
          <p>暂无客户端 Token</p>
        ) : (
          clients.map((client, index) => (
            <div className="client-row" key={client.id}>
              <TextInput value={client.name} placeholder="客户端名称" onChange={(e) => onUpdate(index, { name: e.target.value })} />
              <TextInput value={client.token} placeholder="Client Token" onChange={(e) => onUpdate(index, { token: e.target.value })} />
              <Select
                value={client.app_type}
                onChange={(value) => value && onUpdate(index, { app_type: value })}
                data={[
                  { value: "local", label: "本机" },
                  { value: "claude-code", label: "Claude Code" },
                  { value: "cursor", label: "Cursor" },
                  { value: "cline", label: "Cline" },
                  { value: "open-webui", label: "Open WebUI" },
                  { value: "cherry-studio", label: "Cherry Studio" },
                  { value: "continue", label: "Continue" },
                  { value: "custom", label: "自定义" },
                ]}
              />
              <Button type="button" variant="default" onClick={() => void onCopy(`Bearer ${client.token}`, "Client Token 已复制")}>复制</Button>
              <Button type="button" variant="subtle" color="red" onClick={() => onRemove(index)}>删除</Button>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
