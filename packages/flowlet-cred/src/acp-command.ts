import { parseArgs } from "node:util";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { CredentialStore } from "./store.ts";
import { readA2aConfig } from "./a2a-config.ts";
import { createAcpBridge } from "./acp.ts";
import { agentProtocolRouter } from "@agentclientprotocol/sdk/experimental/v2";
import { createAcpV2Bridge } from "./acp-v2.ts";

export const ACP_USAGE = `flowlet acp [--profile=NAME | --prefix=PREFIX] [--timeout=SECONDS] [--extensions=URIS] [--ignore-client-mcp] [--managed]
  通过 ACP v1 stdio 调用已配置的 A2A 1.0 Agent，供 T3 Code / Paseo 等客户端启动。
  复用 FLOWLET_A2A_<NAME>_URL / _TOKEN 成对凭据；默认 FLOWLET_A2A_URL / _TOKEN。
  stdout 仅输出 ACP 协议；不安装插件，不执行客户端文件或终端操作。
  --ignore-client-mcp：显式忽略客户端附带的 MCP 配置，仅使用远程 Agent 能力（兼容 T3 自动注入）。
  --managed：对支持后台托管的新 Host 启用 ACP v2 草案状态通知；保留 ACP v1 兼容入口。
`;
export async function acpCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      prefix: { type: "string" },
      timeout: { type: "string" },
      extensions: { type: "string" },
      "ignore-client-mcp": { type: "boolean" },
      managed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(ACP_USAGE);
    return 0;
  }
  if (
    positionals.length ||
    (values.profile !== undefined && values.prefix !== undefined)
  )
    throw new Error("acp 仅接受选项；--profile 与 --prefix 互斥");
  const profile = values.profile?.toUpperCase();
  if (profile !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(profile))
    throw new Error("ACP profile 无效");
  const prefix =
    values.prefix ?? (profile ? `FLOWLET_A2A_${profile}` : "FLOWLET_A2A");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(prefix))
    throw new Error("ACP 凭据前缀无效");
  const timeout = values.timeout ?? "900";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 3600)
    throw new Error("--timeout 必须为 1–3600 秒");
  const store = CredentialStore.fromDefaultDir();
  const config = readA2aConfig(store, prefix);
  const bridgeConfig = {
    ...config,
    prefix,
    dir: store.dir,
    timeoutSeconds: Number(timeout),
    extensions: values.extensions,
    ignoreClientMcp: values["ignore-client-mcp"] === true,
  };
  const app = createAcpBridge(bridgeConfig);
  const managed = values.managed
    ? createAcpV2Bridge(createAcpBridge(bridgeConfig))
    : undefined;
  const router = agentProtocolRouter().withV1(app);
  if (managed) router.withV2(managed.app);
  const connection = router.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
      { maxMessageBytes: 4 * 1024 * 1024 },
    ),
  );
  const close = () => {
    managed?.close();
    process.stdin.destroy();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await connection.closed;
    return 0;
  } finally {
    managed?.close();
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}
