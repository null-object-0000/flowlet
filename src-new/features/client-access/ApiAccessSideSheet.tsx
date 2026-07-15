import { SideSheet, Typography } from "@douyinfe/semi-ui-19";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { CopyableAccessValue } from "./CopyableAccessValue";
import styles from "./ApiAccessSideSheet.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";

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
  const { t } = useAppPreferences();
  const host = bindConfig.host || "127.0.0.1";
  const serviceRows: DetailRow[] = [
    { label: t("服务基础地址"), value: baseUrl, copyValue: baseUrl, copyMessage: t("{label} 已复制", { label: t("服务基础地址") }) },
    { label: t("监听地址"), value: running ? `${host}:${bindConfig.port}` : "-", copyValue: running ? `${host}:${bindConfig.port}` : undefined, copyMessage: t("{label} 已复制", { label: t("监听地址") }) },
    { label: t("健康检查地址"), value: "/health", copyValue: `${baseUrl}/health`, copyMessage: t("{label} 已复制", { label: t("健康检查地址") }) },
  ];
  const openAiRows: DetailRow[] = [
    { label: "Base URL", copyLabel: "OpenAI Base URL", value: `${baseUrl}/v1`, copyValue: `${baseUrl}/v1`, copyMessage: t("{label} 已复制", { label: "OpenAI Base URL" }) },
    { label: t("模型列表"), copyLabel: `OpenAI ${t("模型列表")}`, value: `${baseUrl}/v1/models`, copyValue: `${baseUrl}/v1/models` },
    { label: t("对话接口"), copyLabel: `OpenAI ${t("对话接口")}`, value: `${baseUrl}/v1/chat/completions`, copyValue: `${baseUrl}/v1/chat/completions` },
    { label: t("鉴权 Header"), value: "Authorization: Bearer <Client Token>", copyValue: "Authorization: Bearer <Client Token>" },
  ];
  const anthropicRows: DetailRow[] = [
    { label: "Base URL", copyLabel: "Anthropic Base URL", value: `${baseUrl}/anthropic`, copyValue: `${baseUrl}/anthropic`, copyMessage: t("{label} 已复制", { label: "Anthropic Base URL" }) },
    { label: t("模型列表"), copyLabel: `Anthropic ${t("模型列表")}`, value: `${baseUrl}/anthropic/v1/models`, copyValue: `${baseUrl}/anthropic/v1/models` },
    { label: t("消息接口"), copyLabel: `Anthropic ${t("消息接口")}`, value: `${baseUrl}/anthropic/v1/messages`, copyValue: `${baseUrl}/anthropic/v1/messages` },
  ];

  return (
    <SideSheet
      visible={visible}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      onCancel={onClose}
      title={t("API 接入详情")}
      width="min(720px, 92vw)"
      footer={null}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <DetailSection icon="▣" title={t("服务信息")} rows={serviceRows} onCopy={onCopy} />
        <DetailSection icon="▤" title="OpenAI-compatible" rows={openAiRows} onCopy={onCopy} />
        <DetailSection icon="▤" title="Anthropic-compatible" rows={anthropicRows} onCopy={onCopy}>
          <div className={styles.multiRow}>
            <span>{t("鉴权 Header")}</span>
            <div className={styles.headerStack}>
              <CopyValue value="Authorization: Bearer <Client Token>" message={t("{label} 已复制", { label: "Authorization Header" })} onCopy={onCopy} />
              <CopyValue value="X-Api-Key: <Client Token>" message={t("{label} 已复制", { label: "X-Api-Key Header" })} onCopy={onCopy} />
            </div>
          </div>
        </DetailSection>
        <section className={`${styles.section} ${styles.security}`}>
          <Title heading={5} className={styles.sectionTitle}>⚠ {t("安全提示")}</Title>
          <ul>
            <li>{t("客户端应使用 Flowlet Client Token，不要直接配置上游渠道的真实 API Key。")}</li>
            <li>{t("Flowlet 根据 Client Token 识别请求来源，并在转发时替换上游鉴权信息。")}</li>
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
