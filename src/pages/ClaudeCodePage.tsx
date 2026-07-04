import { Actions, Panel, PanelHeader } from "../components/ui";
import { ClientConfig } from "../domain";

export function ClaudeCodePage({
  clients,
  onCopy,
  baseUrl = "http://127.0.0.1:18640",
}: {
  clients: ClientConfig[];
  onCopy: (text: string, done: string) => Promise<void>;
  baseUrl?: string;
}) {
  const defaultClient = clients.find((c) => c.id === "client-default") ?? clients[0];
  const token = defaultClient?.token ?? "flowlet-local-token";
  const anthropicBaseUrl = `${baseUrl}/anthropic`;

  return (
    <Panel>
      <PanelHeader>
        <h3>Claude Code 接入向导</h3>
      </PanelHeader>
      <p>Claude Code 通过 Anthropic-compatible 协议接入 Flowlet。请在 Claude Code 环境中设置以下变量：</p>
      <div className="info-grid">
        <label>
          ANTHROPIC_BASE_URL
          <input readOnly value={anthropicBaseUrl} />
        </label>
        <label>
          ANTHROPIC_AUTH_TOKEN
          <input readOnly value={token} />
        </label>
      </div>
      <Actions>
        <button onClick={() => void onCopy(`export ANTHROPIC_BASE_URL=${anthropicBaseUrl}`, "已复制 BASE_URL")}>复制 BASE_URL</button>
        <button onClick={() => void onCopy(`export ANTHROPIC_AUTH_TOKEN=${token}`, "已复制 AUTH_TOKEN")}>复制 AUTH_TOKEN</button>
        <button
          onClick={() =>
            void onCopy(
              `export ANTHROPIC_BASE_URL=${anthropicBaseUrl}\nexport ANTHROPIC_AUTH_TOKEN=${token}`,
              "已复制完整配置"
            )
          }
        >
          复制完整配置
        </button>
      </Actions>
      <p className="hint">
        X-Api-Key 方式：将 <code>ANTHROPIC_AUTH_TOKEN</code> 替换为 <code>ANTHROPIC_API_KEY</code>，Flowlet 同样支持。
      </p>
    </Panel>
  );
}


