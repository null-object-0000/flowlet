import { SideSheet, Typography } from "@douyinfe/semi-ui-19";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { CopyableAccessValue } from "./CopyableAccessValue";
import styles from "./ApiAccessSideSheet.module.css";

const { Text, Title } = Typography;

type Copy = (value: string, message: string) => Promise<void>;
type DetailRow = { label: string; value: string; copyValue?: string; copyMessage?: string; copyLabel?: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  baseUrl: string;
  bindConfig: ProxyBindConfig;
  running: boolean;
  onCopy: Copy;
};

export function ApiAccessSideSheet({ visible, onClose, baseUrl, bindConfig, running, onCopy }: Props) {
  const host = bindConfig.host || "127.0.0.1";
  const serviceRows: DetailRow[] = [
    { label: "服务基础地址", value: baseUrl, copyValue: baseUrl, copyMessage: "服务基础地址已复制" },
    { label: "监听地址", value: running ? `${host}:${bindConfig.port}` : "-", copyValue: running ? `${host}:${bindConfig.port}` : undefined, copyMessage: "监听地址已复制" },
    { label: "健康检查地址", value: "/health", copyValue: `${baseUrl}/health`, copyMessage: "健康检查地址已复制" },
  ];
  const openAiRows: DetailRow[] = [
    { label: "Base URL", copyLabel: "OpenAI Base URL", value: `${baseUrl}/v1`, copyValue: `${baseUrl}/v1`, copyMessage: "OpenAI Base URL 已复制" },
    { label: "模型列表", copyLabel: "OpenAI 模型列表", value: `${baseUrl}/v1/models`, copyValue: `${baseUrl}/v1/models`, copyMessage: "模型列表地址已复制" },
    { label: "对话接口", copyLabel: "OpenAI 对话接口", value: `${baseUrl}/v1/chat/completions`, copyValue: `${baseUrl}/v1/chat/completions`, copyMessage: "对话接口地址已复制" },
    { label: "鉴权 Header", value: "Authorization: Bearer <Client Token>", copyValue: "Authorization: Bearer <Client Token>", copyMessage: "鉴权 Header 已复制" },
  ];
  const anthropicRows: DetailRow[] = [
    { label: "Base URL", copyLabel: "Anthropic Base URL", value: `${baseUrl}/anthropic`, copyValue: `${baseUrl}/anthropic`, copyMessage: "Anthropic Base URL 已复制" },
    { label: "模型列表", copyLabel: "Anthropic 模型列表", value: `${baseUrl}/anthropic/v1/models`, copyValue: `${baseUrl}/anthropic/v1/models`, copyMessage: "Anthropic 模型列表地址已复制" },
    { label: "消息接口", copyLabel: "Anthropic 消息接口", value: `${baseUrl}/anthropic/v1/messages`, copyValue: `${baseUrl}/anthropic/v1/messages`, copyMessage: "消息接口地址已复制" },
  ];

  return (
    <SideSheet
      visible={visible}
      zIndex={1100}
      onCancel={onClose}
      title="API 接入详情"
      width="min(720px, 92vw)"
      footer={null}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <DetailSection icon="▣" title="服务信息" rows={serviceRows} onCopy={onCopy} />
        <DetailSection icon="▤" title="OpenAI-compatible" rows={openAiRows} onCopy={onCopy} />
        <DetailSection icon="▤" title="Anthropic-compatible" rows={anthropicRows} onCopy={onCopy}>
          <div className={styles.multiRow}>
            <span>鉴权 Header</span>
            <div className={styles.headerStack}>
              <CopyValue value="Authorization: Bearer <Client Token>" message="Authorization Header 已复制" onCopy={onCopy} />
              <CopyValue value="X-Api-Key: <Client Token>" message="X-Api-Key Header 已复制" onCopy={onCopy} />
            </div>
          </div>
        </DetailSection>
        <section className={`${styles.section} ${styles.security}`}>
          <Title heading={5} className={styles.sectionTitle}>⚠ 安全提示</Title>
          <ul>
            <li>客户端应使用 <code>Flowlet Client Token</code>，不要直接配置上游渠道的真实 API Key。</li>
            <li>Flowlet 根据 Client Token 识别请求来源，并在转发时替换上游鉴权信息。</li>
          </ul>
        </section>
      </div>
    </SideSheet>
  );
}

function DetailSection({ icon, title, rows, onCopy, children }: {
  icon: string;
  title: string;
  rows: DetailRow[];
  onCopy: Copy;
  children?: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <Title heading={5} className={styles.sectionTitle}>{icon} {title}</Title>
      {rows.map((row) => <DetailValueRow key={row.label} row={row} onCopy={onCopy} />)}
      {children}
    </section>
  );
}

function DetailValueRow({ row, onCopy }: { row: DetailRow; onCopy: Copy }) {
  return (
    <div className={styles.row}>
      <Text type="tertiary" size="small">{row.label}</Text>
      {row.copyValue ? (
        <CopyableAccessValue label={row.copyLabel ?? row.label} value={row.value} copyValue={row.copyValue} copyMessage={row.copyMessage} onCopy={onCopy} />
      ) : <code className={styles.staticValue}>{row.value}</code>}
    </div>
  );
}

function CopyValue({ value, message, onCopy }: { value: string; message: string; onCopy: Copy }) {
  return <CopyableAccessValue label={value} value={value} copyMessage={message} onCopy={onCopy} />;
}
