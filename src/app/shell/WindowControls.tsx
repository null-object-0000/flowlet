import { useEffect, useState } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { IconClose, IconMaximize2, IconMinus, IconRestore } from "@douyinfe/semi-icons";
import { isDesktopHost } from "../../platform/desktop/mode";
import { windowCommands } from "../../platform/host/window";
import { WindowResizeHandles } from "./WindowResizeHandles";
import styles from "./WindowControls.module.css";
import { useAppPreferences } from "../preferences/AppPreferences";

/** 窗口命令失败时记录到控制台，不静默吞掉 rejection。 */
function runWindowCommand(action: () => Promise<void>, label: string) {
  void action().catch((error) => {
    console.error(`Window command failed: ${label}`, error);
  });
}

/**
 * 无边框窗口的顶部控制条：整行拖拽区 + 窗口控制按钮。
 * `standalone` 用于独立窗口（没有左侧边栏），拖拽区延伸至窗口左边缘；
 * 主窗口保持默认值（左侧留出侧边栏宽度）。
 *
 * Electron desktop 壳的拖拽区用 CSS `-webkit-app-region: drag`（拖动与双击最大化
 * 交给平台），不再在 mousedown 里调用程序化拖动（HG-2）。
 */
export function WindowControls({ standalone = false }: { standalone?: boolean }) {
  const { t } = useAppPreferences();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktopHost) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        const maximized = await windowCommands.isMaximized();
        if (!disposed) setIsMaximized(maximized);
      } catch (error) {
        console.error("Failed to read the window maximized state", error);
      }
    };

    void syncMaximizedState();
    void windowCommands
      .onResized(() => void syncMaximizedState())
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        console.error("Failed to subscribe to window resize events", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const toggleMaximize = () => runWindowCommand(() => windowCommands.toggleMaximize(), "toggle-maximize");

  const dragRegionClassName = [
    styles.dragRegion,
    standalone ? styles.dragRegionStandalone : "",
    isDesktopHost ? styles.dragRegionDesktop : "",
  ]
    .filter(Boolean)
    .join(" ");
  const controlsClassName = [styles.controls, isDesktopHost ? styles.controlsDesktop : ""]
    .filter(Boolean)
    .join(" ");

  if (!isDesktopHost) return null;

  return (
    <>
      <WindowResizeHandles />
      <div
        className={dragRegionClassName}
        role="presentation"
        data-testid="titlebar-drag-region"
      />
      <div className={controlsClassName}>
        <Button
          className={styles.control}
          icon={<IconMinus />}
          type="tertiary"
          theme="borderless"
          aria-label={t("最小化")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => runWindowCommand(() => windowCommands.minimize(), "minimize")}
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
          onClick={() => runWindowCommand(() => windowCommands.close(), "close")}
        />
      </div>
    </>
  );
}
