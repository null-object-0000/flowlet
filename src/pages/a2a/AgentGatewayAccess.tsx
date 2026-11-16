import { useEffect, useRef, useState } from "react";
import { proxyCommands } from "../../domains/proxy/commands";
import { copyText } from "../../shared/ui/copyText";
import { errorMessage } from "../../shared/errors/AppError";
import {
  Banner,
  Button,
  SideSheet,
  Toast,
  Typography,
} from "@douyinfe/semi-ui-19";
import type { A2aAgent } from "../../domains/a2a/types";
import { agentAccessConfig } from "../../domains/a2a/access";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./A2aPage.module.css";

export function AgentGatewayAccess({
  agent,
  origin,
  onClose,
}: {
  agent: A2aAgent | null;
  origin: string;
  onClose: () => void;
}) {
  const [visibleToken, setVisibleToken] = useState("");
  const [pending, setPending] = useState(false);
  const currentAgent = useRef(agent?.id);
  currentAgent.current = agent?.id;
  useEffect(() => {
    setVisibleToken("");
  }, [agent?.id, origin]);
  const readToken = async () => {
    const value = (await proxyCommands.bindConfig()).default_client_token;
    if (!value) throw new Error("请先设置 Flowlet Client Token");
    return value;
  };
  const act = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const copyConfig = (kind: "acp" | "paseo") =>
    act(async () => {
      if (!agent) return;
      const value = agentAccessConfig(agent, origin, await readToken());
      await copyText(
        JSON.stringify(
          kind === "paseo"
            ? value.paseo
            : { command: value.command, args: value.args, env: value.env },
          null,
          2,
        ),
      );
      Toast.success("已复制完整配置（包含 Client Token）");
    });
  const config = agent ? agentAccessConfig(agent, origin) : null;
  return (
    <SideSheet
      title={agent ? `接入 ${agent.name}` : "Agent 接入"}
      visible={!!agent}
      width={640}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      onCancel={() => {
        setVisibleToken("");
        onClose();
      }}
    >
      {config && (
        <div className={styles.form}>
          <Banner description="统一使用概览页的 Flowlet Client Token，无需另外创建调用密钥。更换 Client Token 后，模型服务与 Agent 网关同时生效。" />
          <label className={styles.field}>
            Client Token
            <code style={{ overflowWrap: "anywhere" }}>
              {visibleToken || "••••••••••••••••"}
            </code>
          </label>
          <div className={styles.actions}>
            <Button
              loading={pending}
              onClick={() =>
                visibleToken
                  ? setVisibleToken("")
                  : void act(async () => {
                      const id = agent?.id;
                      const token = await readToken();
                      if (currentAgent.current === id) setVisibleToken(token);
                    })
              }
            >
              {visibleToken ? "隐藏" : "查看 Token"}
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                void act(async () => {
                  await copyText(await readToken());
                  Toast.success("Client Token 已复制");
                })
              }
            >
              复制 Token
            </Button>
          </div>
          <p className={styles.muted}>
            在运行 T3 Code / Paseo 服务端的机器上安装 Flowlet
            CLI，然后复制下方配置。
          </p>
          <strong>通过 A2A 调用</strong>
          <label className={styles.field}>
            Agent Card
            <Typography.Text copyable>{config.cardUrl}</Typography.Text>
          </label>
          <label className={styles.field}>
            JSON-RPC 入口
            <Typography.Text copyable>{config.url}</Typography.Text>
          </label>
          <p className={styles.muted}>
            使用 Bearer Client Token；请求头 A2A-Version: 1.0。
          </p>
          <strong>通过 ACP 调用 · T3 Code</strong>
          <p>
            在 Providers 中添加 Local ACP command。复制完整配置时会自动填入
            Client Token。
          </p>
          <Button loading={pending} onClick={() => void copyConfig("acp")}>
            复制完整 ACP 配置
          </Button>
          <pre className={styles.code}>
            {JSON.stringify(
              { command: config.command, args: config.args, env: config.env },
              null,
              2,
            )}
          </pre>
          <strong>Paseo 配置</strong>
          <p>合并到 Paseo 的 config.json，保留已有 Provider。</p>
          <Button loading={pending} onClick={() => void copyConfig("paseo")}>
            复制完整 Paseo 配置
          </Button>
          <pre className={styles.code}>
            {JSON.stringify(config.paseo, null, 2)}
          </pre>
          <p className={styles.muted}>
            ACP 桥使用
            v1，支持文本、资源链接、会话恢复和任务取消。上游产物以可更新的输出卡片展示；等待补充输入时由用户回复继续。Agent
            执行能力与底层模型由上游提供，当前仅可选择上游默认模型。启动参数中的
            --ignore-client-mcp 显式忽略 T3 附带的 MCP
            配置；桥接不执行或转发这些工具，也不接管客户端文件和终端。
          </p>
        </div>
      )}
    </SideSheet>
  );
}
