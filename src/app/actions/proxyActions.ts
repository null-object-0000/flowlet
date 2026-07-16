import { runCommand, logToRust } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createProxyActions({ data, setMessage }: ActionContext) {
  const { refreshStatus } = data;

  function startProxy() {
    return runCommand("start_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已启动");
      })
      .catch((err: unknown) => {
        setMessage(`启动失败: ${String(err)}`);
        throw err;
      });
  }

  function stopProxy() {
    return runCommand("stop_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已停止");
      })
      .catch((err: unknown) => setMessage(`停止失败: ${String(err)}`));
  }

  async function restartProxy() {
    setMessage("正在重启代理...");
    try {
      await runCommand("stop_proxy");
      await runCommand("start_proxy");
      await refreshStatus();
      setMessage("代理已重启，配置已生效");
    } catch (err: unknown) {
      const msg = `重启失败: ${String(err)}`;
      setMessage(msg);
      logToRust("error", msg);
      throw err;
    }
  }

  async function testModel(model: string) {
    const { host, port } = data.proxyBindConfig;
    const baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    setMessage(`正在测试 ${model}...`);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `HTTP ${response.status}`);
      }
      setMessage(`${model} 测试成功`);
    } catch (err) {
      const msg = `${model} 测试失败: ${err instanceof Error ? err.message : String(err)}`;
      setMessage(msg);
      logToRust("error", msg);
    }
  }
  async function copy(text: string, done: string) {
    await navigator.clipboard.writeText(text);
    setMessage(done);
  }

  return { startProxy, stopProxy, restartProxy, testModel, copy };
}
