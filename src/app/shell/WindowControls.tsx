import { Button } from "@douyinfe/semi-ui-19";
import { IconClose, IconMaximize, IconMinus } from "@douyinfe/semi-icons";
import { windowCommands } from "../../platform/tauri/window";
import styles from "./WindowControls.module.css";
import { useAppPreferences } from "../preferences/AppPreferences";

export function WindowControls() {
  const { t } = useAppPreferences();
  const startWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void windowCommands.startDragging();
  };
  const toggleMaximize = () => void windowCommands.toggleMaximize();

  return (
    <>
      <div className={styles.dragRegion} onPointerDown={startWindowDrag} onDoubleClick={toggleMaximize} role="presentation" />
      <div className={styles.controls}>
        <Button
          className={styles.control}
          icon={<IconMinus />}
          type="tertiary"
          theme="borderless"
          aria-label={t("最小化")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void windowCommands.minimize()}
        />
        <Button
          className={styles.control}
          icon={<IconMaximize />}
          type="tertiary"
          theme="borderless"
          aria-label={t("最大化")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleMaximize}
        />
        <Button
          className={`${styles.control} ${styles.close}`}
          icon={<IconClose />}
          type="tertiary"
          theme="borderless"
          aria-label={t("关闭")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void windowCommands.close()}
        />
      </div>
    </>
  );
}
