import { Button, Select, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy } from "@douyinfe/semi-icons";
import type { AgentGlobalConfigState } from "../../domains/agent/types";
import type { AgentModelOption } from "./agentAccessAdapters";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./AgentAccessSideSheet.module.css";

const { Text } = Typography;

/** Agent 全局配置状态 → 标签文案与颜色。各 Agent 的一键接入抽屉共享。 */
export function globalConfigTag(state: AgentGlobalConfigState): { label: string; color: "green" | "orange" | "red" | "grey" } {
  const values: Record<AgentGlobalConfigState, { label: string; color: "green" | "orange" | "red" | "grey" }> = {
    not_configured: { label: "未配置", color: "grey" },
    flowlet: { label: "已接入 Flowlet", color: "green" },
    other_gateway: { label: "已配置其他网关", color: "orange" },
    partial: { label: "配置不完整", color: "orange" },
    invalid: { label: "配置文件无效", color: "red" },
  };
  return values[state];
}

/** 可复制的配置项行（如配置文件路径）。 */
export function ConfigRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => Promise<void> }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.configRow}>
      <Text type="tertiary" size="small">{label}</Text>
      <code>{value}</code>
      <Button icon={<IconCopy />} theme="borderless" aria-label={t("复制{label}", { label })} onClick={() => void onCopy()} />
    </div>
  );
}

/** 只读状态行（如 Base URL、主模型）。 */
export function StatusRow({ label, value }: { label: string; value: string }) {
  return <div className={styles.statusRow}><Text type="tertiary" size="small">{label}</Text><code>{value}</code></div>;
}

/**
 * 默认模型选择行：选项来自接入抽屉按协议过滤后的可用模型池。
 * 无可用模型时显示占位文案并禁用，避免用户误以为一键接入可用。
 */
export function ModelSelectorRow({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: AgentModelOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.statusRow}>
      <Text type="tertiary" size="small">{label}</Text>
      <Select
        className={styles.modelSelect}
        size="small"
        value={value || undefined}
        placeholder={t("暂无可用模型")}
        optionList={options}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
        disabled={disabled}
        onChange={(next) => onChange(String(next))}
      />
    </div>
  );
}
