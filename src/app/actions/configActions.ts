import { runCommand } from "../../services/flowletApi";
import { ActionContext, FlowletData } from "./types";

function validateConfigData({ channels, accounts, routes, clients }: FlowletData): string[] {
  const errors: string[] = [];

  if (channels.length === 0) {
    errors.push("至少需要一个渠道");
  }

  const enabledAccounts = accounts.filter((account) => account.enabled);
  const enabledRoutes = routes.filter((route) => route.enabled);

  if (enabledAccounts.length === 0) {
    errors.push("请先新增并启用至少一个渠道账号");
  }
  if (enabledRoutes.length === 0) {
    errors.push("请至少开放一个模型");
  }

  for (const account of enabledAccounts) {
    if (!account.api_key.trim()) {
      errors.push(`账号 '${account.name}' 未配置 API Key`);
    }
    if (!channels.some((channel) => channel.id === account.channel_id)) {
      errors.push(`账号 '${account.name}' 引用了不存在的渠道 '${account.channel_id}'`);
    }
  }

  for (const route of enabledRoutes) {
    if (!channels.some((channel) => channel.id === route.channel_id)) {
      errors.push(`对外开放模型 '${route.upstream_model}' 找不到可用渠道`);
    }
    const account = accounts.find((item) => item.id === route.account_id);
    if (!account) {
      errors.push(`对外开放模型 '${route.upstream_model}' 找不到可用账号`);
      continue;
    }
    if (!account.enabled) {
      errors.push(`对外开放模型 '${route.upstream_model}' 使用的账号 '${account.name}' 未启用`);
    }
    if (!account.api_key.trim()) {
      errors.push(`对外开放模型 '${route.upstream_model}' 使用的账号 '${account.name}' 未配置 API Key`);
    }
    if (account.channel_id !== route.channel_id) {
      errors.push(`对外开放模型 '${route.upstream_model}' 的来源渠道与账号所属渠道不一致`);
    }
  }

  for (const client of clients.filter((item) => item.enabled)) {
    if (!client.token.trim()) {
      errors.push(`客户端 '${client.name}' 未配置 Token`);
    }
  }

  return errors;
}

export function createConfigActions({ data, setMessage }: ActionContext) {
  const { autostartEnabled, setAutostartEnabled, proxyBindConfig, setProxyBindConfig, status, refreshStatus, refreshAll } = data;

  function toggleAutostart() {
    const fn = autostartEnabled ? "disable_autostart" : "enable_autostart";
    runCommand(fn)
      .then(async () => {
        const enabled = await runCommand<boolean>("is_autostart_enabled");
        setAutostartEnabled(enabled);
        setMessage(enabled ? "已启用开机自启动" : "已禁用开机自启动");
      })
      .catch((err: unknown) => setMessage(`自启动设置失败: ${String(err)}`));
  }

  function exportConfig() {
    runCommand<string>("export_config")
      .then((json) => {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flowlet-config-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setMessage("配置已导出");
      })
      .catch((err: unknown) => setMessage(`导出失败: ${String(err)}`));
  }

  function importConfig() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const json = reader.result as string;
        runCommand("import_config", { json })
          .then(async () => {
            await refreshAll();
            setMessage("配置已导入");
          })
          .catch((err: unknown) => setMessage(`导入失败: ${String(err)}`));
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function validateConfig() {
    const errors = validateConfigData(data);
    if (errors.length === 0) {
      setMessage("✅ 配置验证通过");
    } else {
      setMessage(`⚠️ 发现 ${errors.length} 个问题: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "..." : ""}`);
    }
  }


  function saveProxyBindConfig(nextAllowLan: boolean) {
    const next = {
      host: nextAllowLan ? "0.0.0.0" : "127.0.0.1",
      port: proxyBindConfig.port || 18640,
      allow_lan: nextAllowLan,
    };
    runCommand("set_proxy_bind_config", { config: next })
      .then(async () => {
        setProxyBindConfig(next);
        if (status.running) {
          setMessage("代理监听配置已保存，正在重启代理...");
          await runCommand("stop_proxy");
          await runCommand("start_proxy");
          await refreshStatus().catch(() => undefined);
          setMessage("代理监听配置已保存，代理已按新地址重启");
          return;
        }
        await refreshStatus().catch(() => undefined);
        setMessage("代理监听配置已保存");
      })
      .catch((err: unknown) => setMessage(`保存代理监听配置失败: ${String(err)}`));
  }
  function cleanupLogs(keepDays: number) {
    runCommand<[number, number]>("cleanup_old_logs", { keepDays })
      .then(([logs, usage]) => {
        setMessage(`已清理 ${logs} 条日志、${usage} 条用量记录`);
        void refreshAll();
      })
      .catch((err: unknown) => setMessage(`清理失败: ${String(err)}`));
  }

  return { toggleAutostart, saveProxyBindConfig, exportConfig, importConfig, validateConfig, cleanupLogs };
}


