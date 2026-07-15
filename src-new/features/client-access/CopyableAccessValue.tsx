import { IconCopy } from "@douyinfe/semi-icons";
import styles from "./CopyableAccessValue.module.css";

type Props = {
  label: string;
  value: string;
  copyValue?: string;
  copyMessage?: string;
  onCopy: (value: string, message: string) => Promise<void>;
};

export function CopyableAccessValue({ label, value, copyValue = value, copyMessage, onCopy }: Props) {
  return (
    <button
      type="button"
      className={styles.valueBox}
      aria-label={`复制${label}`}
      onClick={() => void onCopy(copyValue, copyMessage ?? `${label} 已复制`)}
    >
      <code>{value}</code>
      <IconCopy className={styles.copyIcon} aria-hidden="true" />
    </button>
  );
}
