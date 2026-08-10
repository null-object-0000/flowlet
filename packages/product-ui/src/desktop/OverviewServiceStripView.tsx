import { useState } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { IconCopy, IconEyeClosed, IconEyeOpened, IconLink } from "@douyinfe/semi-icons";
import styles from "./OverviewServiceStripView.module.css";

export type ProductProtocol = "openai" | "anthropic";

export type OverviewServiceStripModel = {
  running: boolean;
  statusTitle: string;
  statusSubtitle: string;
  statusTooltip?: string;
  usageLabel: string;
  usageValue: string;
  usageUnit: string;
  accessLabel: string;
  detailLabel: string;
  endpoints: Record<ProductProtocol, string>;
  tokenLabel: string;
  clientToken?: string | null;
  usageAriaLabel?: string;
};

export type OverviewServiceStripLabels = {
  copyBaseUrl: string;
  testConnection: string;
  copyToken: string;
  showToken: string;
  hideToken: string;
};

type Props = {
  model: OverviewServiceStripModel;
  labels: OverviewServiceStripLabels;
  density?: "default" | "compact";
  onOpenUsage?: () => void;
  onOpenDetails?: () => void;
  onCopy?: (value: string, kind: "endpoint" | "token") => void | Promise<void>;
  onTest?: (protocol: ProductProtocol) => void | Promise<void>;
};

export function OverviewServiceStripView({
  model,
  labels,
  density = "default",
  onOpenUsage,
  onOpenDetails,
  onCopy,
  onTest,
}: Props) {
  const [protocol, setProtocol] = useState<ProductProtocol>("openai");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const endpoint = model.endpoints[protocol];

  const test = async () => {
    if (!onTest || testing) return;
    setTesting(true);
    try {
      await onTest(protocol);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={`${styles.strip} ${density === "compact" ? styles.compact : ""}`}>
      <div className={styles.cell}>
        <div className={styles.statusCompact}>
          <i className={`${styles.statusDot} ${model.running ? "" : styles.statusDotStopped}`} aria-hidden="true" />
          <div className={styles.statusCopy}>
            <div className={styles.statusTitle}>{model.statusTitle}</div>
            <div className={styles.statusSub} title={model.statusTooltip}>{model.statusSubtitle}</div>
          </div>
        </div>
      </div>

      <button type="button" className={`${styles.cell} ${styles.tokenMetric}`} aria-label={model.usageAriaLabel} onClick={onOpenUsage}>
        <div className={styles.tokenLabel}>{model.usageLabel}</div>
        <div className={styles.tokenValue}>{model.usageValue}<span className={styles.tokenUnit}>{model.usageUnit}</span></div>
      </button>

      <div className={styles.cell}>
        <div className={styles.accessHead}>
          <span className={styles.accessLabel}>{model.accessLabel}</span>
          <div className={styles.protocolSwitch}>
            {(["openai", "anthropic"] as const).map((value) => (
              <button key={value} type="button" className={`${styles.protocolBtn} ${protocol === value ? styles.protocolBtnActive : ""}`} onClick={() => setProtocol(value)}>
                {value === "openai" ? "OpenAI" : "Anthropic"}
              </button>
            ))}
          </div>
          {onOpenDetails ? <button type="button" className={styles.accessDetail} onClick={onOpenDetails}>{model.detailLabel}</button> : null}
        </div>
        <div className={styles.inlineEndpoint}>
          <div className={styles.inlineCode}>{endpoint}</div>
          {onCopy ? <button type="button" className={styles.iconBtn} title={labels.copyBaseUrl} aria-label={labels.copyBaseUrl} onClick={() => void onCopy(endpoint, "endpoint")}><IconCopy aria-hidden="true" /></button> : null}
          {onTest ? <Button className={styles.iconBtn} icon={<IconLink aria-hidden="true" />} title={labels.testConnection} aria-label={labels.testConnection} loading={testing} theme="borderless" onClick={() => void test()} /> : null}
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.tokenCellLabel}>{model.tokenLabel}</div>
        <div className={styles.tokenRow}>
          <div className={styles.tokenValueMasked}>{model.clientToken ? (tokenVisible ? model.clientToken : "••••••••••••••••") : "—"}</div>
          {model.clientToken ? <button type="button" className={styles.iconBtn} title={tokenVisible ? labels.hideToken : labels.showToken} aria-label={tokenVisible ? labels.hideToken : labels.showToken} aria-pressed={tokenVisible} onClick={() => setTokenVisible((value) => !value)}>{tokenVisible ? <IconEyeClosed aria-hidden="true" /> : <IconEyeOpened aria-hidden="true" />}</button> : null}
          {model.clientToken && onCopy ? <button type="button" className={styles.iconBtn} title={labels.copyToken} aria-label={labels.copyToken} onClick={() => void onCopy(model.clientToken!, "token")}><IconCopy aria-hidden="true" /></button> : null}
        </div>
      </div>
    </div>
  );
}
