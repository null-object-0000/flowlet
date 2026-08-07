import { useEffect, useState } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { IconClose, IconExternalOpen, IconMaximize2, IconMinus, IconRestore } from "@douyinfe/semi-icons";
import { windowCommands } from "../../platform/tauri/window";
import styles from "./WindowControls.module.css";
import { useAppPreferences } from "../preferences/AppPreferences";

/**
 * 无边框窗口的顶部控制条：整行拖拽区 + 窗口控制按钮。
 * `standalone` 用于独立窗口（没有左侧边栏），拖拽区延伸至窗口左边缘；
 * 主窗口保持默认值（左侧留出侧边栏宽度）。
 * `openDetailWindow` 是「在独立窗口打开」公共能力：由上层按当前页面能力注入，
 * 未注入时不渲染该按钮。当前只有项目任务看板使用，其他页面看不到此入口。
 */
export function WindowControls({ standalone = false, openDetailWindow }: { standalone?: boolean; openDetailWindow?: () => void }) {
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

  const onDragRegionMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    if (event.detail === 2) {
      // 双击标题栏：切换最大化/还原。Windows 上 startDragging 会进入系统拖动
      // 模态循环并吞掉 dblclick，因此不能依赖 onDoubleClick，需在 mousedown 直接处理。
      // preventDefault 阻断双击默认的文本选中行为。
      event.preventDefault();
      void windowCommands.toggleMaximize();
      return;
    }
    event.preventDefault();
    void windowCommands.startDragging();
  };
  const toggleMaximize = () => void windowCommands.toggleMaximize();

  return (
    <>
      <div
        className={`${styles.dragRegion}${standalone ? ` ${styles.dragRegionStandalone}` : ""}`}
        onMouseDown={onDragRegionMouseDown}
        role="presentation"
        data-testid="titlebar-drag-region"
      />
      <div className={styles.controls}>
        {openDetailWindow ? (
          <Button
            className={styles.control}
            icon={<IconExternalOpen />}
            type="tertiary"
            theme="borderless"
            aria-label={t("在独立窗口打开")}
            title={t("在独立窗口打开此项目看板，可同时操作主窗口")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void openDetailWindow()}
          />
        ) : null}
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
