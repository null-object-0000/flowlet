import { runCommand } from "../../services/flowletApi";
import { ActionContext } from "./types";

export function createProxyActions({ data, setMessage }: ActionContext) {
  const { refreshStatus } = data;

  function startProxy() {
    return runCommand("start_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已启动");
      })
      .catch((err: unknown) => setMessage(`启动失败: ${String(err)}`));
  }

  function stopProxy() {
    return runCommand("stop_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已停止");
      })
      .catch((err: unknown) => setMessage(`停止失败: ${String(err)}`));
  }

  async function copy(text: string, done: string) {
    await navigator.clipboard.writeText(text);
    setMessage(done);
  }

  return { startProxy, stopProxy, copy };
}
