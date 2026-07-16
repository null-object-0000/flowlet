import { useState } from "react";
import { Toast } from "@douyinfe/semi-ui-19";
import type { ProxyBindConfig } from "../../domains/proxy/types";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ApiAccessSideSheet } from "./ApiAccessSideSheet";
import { CopyableAccessValue } from "./CopyableAccessValue";
import styles from "./OverviewClientAccessCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type Props = {
  baseUrl: string;
  bindConfig: ProxyBindConfig;
  running: boolean;
};

export function OverviewClientAccessCard({ baseUrl, bindConfig, running }: Props) {
  const { t } = useAppPreferences();
  const [detailsVisible, setDetailsVisible] = useState(false);

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <>
      <OverviewModuleCard
        title={t("客户端访问信息")}
        action={t("查看接入详情")}
        onAction={() => setDetailsVisible(true)}
      >
        <div className={styles.endpoints}>
          <EndpointRow label="OpenAI Base URL" value={`${baseUrl}/v1`} onCopy={copy} />
          <EndpointRow label="Anthropic Base URL" value={`${baseUrl}/anthropic`} onCopy={copy} />
          <EndpointRow label={t("健康检查地址")} value={`${baseUrl}/health`} onCopy={copy} />
          {bindConfig.default_client_token ? (
            <EndpointRow
              label={t("默认客户端 Token")}
              value={bindConfig.default_client_token}
              copyValue={`Bearer ${bindConfig.default_client_token}`}
              revealable
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
  revealable = false,
  onCopy,
}: {
  label: string;
  value: string;
  copyValue?: string;
  revealable?: boolean;
  onCopy: (value: string, message: string) => Promise<void>;
}) {
  return (
    <div className={styles.endpointRow}>
      <span className={styles.label}>{label}</span>
      <CopyableAccessValue label={label} value={value} copyValue={copyValue} revealable={revealable} onCopy={onCopy} />
    </div>
  );
}
