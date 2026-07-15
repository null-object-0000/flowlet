import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ApiAccessSideSheet } from "./ApiAccessSideSheet";
import { CopyableAccessValue } from "./CopyableAccessValue";
import styles from "./OverviewClientAccessCard.module.css";

type Props = {
  baseUrl: string;
  bindConfig: ProxyBindConfig;
  running: boolean;
};

export function OverviewClientAccessCard({ baseUrl, bindConfig, running }: Props) {
  const [detailsVisible, setDetailsVisible] = useState(false);

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <>
      <OverviewModuleCard
        title="客户端访问信息"
        action="查看接入详情"
        onAction={() => setDetailsVisible(true)}
      >
        <p className={styles.description}>使用以下地址和 Token 访问本地代理服务</p>
        <div className={styles.endpoints}>
          <EndpointRow label="OpenAI Base URL" value={`${baseUrl}/v1`} onCopy={copy} />
          <EndpointRow label="Anthropic Base URL" value={`${baseUrl}/anthropic`} onCopy={copy} />
          <EndpointRow label="健康检查地址" value={`${baseUrl}/health`} onCopy={copy} />
          {bindConfig.default_client_token ? (
            <EndpointRow
              label="默认客户端 Token"
              value={bindConfig.default_client_token}
              copyValue={`Bearer ${bindConfig.default_client_token}`}
              onCopy={copy}
            />
          ) : null}
        </div>
      </OverviewModuleCard>

      <ApiAccessSideSheet
        visible={detailsVisible}
        onClose={() => setDetailsVisible(false)}
        baseUrl={baseUrl}
        bindConfig={bindConfig}
        running={running}
        onCopy={copy}
      />
    </>
  );
}

function EndpointRow({
  label,
  value,
  copyValue = value,
  onCopy,
}: {
  label: string;
  value: string;
  copyValue?: string;
  onCopy: (value: string, message: string) => Promise<void>;
}) {
  return (
    <div className={styles.endpointRow}>
      <span className={styles.label}>{label}</span>
      <CopyableAccessValue label={label} value={value} copyValue={copyValue} onCopy={onCopy} />
    </div>
  );
}
