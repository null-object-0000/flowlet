import { Banner, SideSheet, Typography } from "@douyinfe/semi-ui-19";
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
  const config = agent ? agentAccessConfig(agent, origin) : null;
  return (
    <SideSheet
      title={agent ? `接入 ${agent.name}` : "Agent 接入"}
      visible={!!agent}
      width={640}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      onCancel={onClose}
    >
      {config && (
        <div className={styles.form}>
          <Banner description="在运行 T3 Code 或 Paseo 服务端的机器上安装 Flowlet CLI，再使用下方配置。调用密钥需在本页单独创建；浏览器页面不会保存客户端凭据。" />
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
            使用 Bearer 调用密钥；请求头 A2A-Version: 1.0。
          </p>
          <strong>通过 ACP 调用 · T3 Code</strong>
          <p>
            在 Providers 中添加 Local ACP command，填写程序、参数与环境变量。将
            Token 占位符替换为专用调用密钥。
          </p>
          <Typography.Text
            copyable={{
              content: JSON.stringify(
                { command: config.command, args: config.args, env: config.env },
                null,
                2,
              ),
            }}
          >
            复制 ACP 启动配置
          </Typography.Text>
          <pre className={styles.code}>
            {JSON.stringify(
              { command: config.command, args: config.args, env: config.env },
              null,
              2,
            )}
          </pre>
          <strong>Paseo 配置</strong>
          <p>合并到 Paseo 的 config.json，保留已有 Provider。</p>
          <Typography.Text
            copyable={{ content: JSON.stringify(config.paseo, null, 2) }}
          >
            复制 Paseo 配置
          </Typography.Text>
          <pre className={styles.code}>
            {JSON.stringify(config.paseo, null, 2)}
          </pre>
          <p className={styles.muted}>
            ACP 桥使用
            v1，支持文本、资源链接、会话恢复和任务取消。上游产物以可更新的输出卡片展示；等待补充输入时由用户回复继续。Agent
            执行能力由上游提供，桥接不接管客户端文件、终端或 MCP。
          </p>
        </div>
      )}
    </SideSheet>
  );
}
