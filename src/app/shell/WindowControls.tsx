import { useEffect, useState } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { IconClose, IconMaximize2, IconMinus, IconRestore } from "@douyinfe/semi-icons";
import { windowCommands } from "../../platform/tauri/window";
import styles from "./WindowControls.module.css";
import { useAppPreferences } from "../preferences/AppPreferences";

export function WindowControls() {
  const { t } = useAppPreferences();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximizedState = async () => {
      const maximized = await windowCommands.isMaximized();
      if (!disposed) setIsMaximized(maximized);
    };

    void syncMaximizedState();
    void windowCommands.onResized(() => void syncMaximizedState()).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
          icon={isMaximized ? <IconRestore /> : <IconMaximize2 />}
          type="tertiary"
          theme="borderless"
          aria-label={t(isMaximized ? "还原" : "最大化")}
          title={t(isMaximized ? "还原" : "最大化")}
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
