import { useState } from "react";
import { IconCopy, IconEyeClosed, IconEyeOpened } from "@douyinfe/semi-icons";
import styles from "./CopyableAccessValue.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type Props = {
  label: string;
  value: string;
  copyValue?: string;
  copyMessage?: string;
  revealable?: boolean;
  onCopy: (value: string, message: string) => Promise<void>;
};

const MASKED_TOKEN = "••••••••••••••••••••";

export function CopyableAccessValue({ label, value, copyValue = value, copyMessage, revealable = false, onCopy }: Props) {
  const { t } = useAppPreferences();
  const [visible, setVisible] = useState(false);
  const copy = () => void onCopy(copyValue, copyMessage ?? t("{label} 已复制", { label }));

  return (
    <div className={styles.valueBox}>
      <button type="button" className={styles.valueButton} aria-label={t("复制{label}", { label })} onClick={copy}>
        <code>{revealable && !visible ? MASKED_TOKEN : value}</code>
      </button>
      {revealable ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t(visible ? "隐藏{label}" : "显示{label}", { label })}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <IconEyeClosed aria-hidden="true" /> : <IconEyeOpened aria-hidden="true" />}
        </button>
      ) : null}
      <button type="button" className={styles.iconButton} aria-label={t("复制{label}（图标）", { label })} onClick={copy}>
        <IconCopy aria-hidden="true" />
      </button>
    </div>
  );
}
