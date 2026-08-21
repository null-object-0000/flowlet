import type { MouseEvent } from "react";
import { windowCommands, type ResizeDirection } from "../../platform/tauri/window";
import styles from "./WindowResizeHandles.module.css";

const HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: "NorthWest", className: "northWest" },
  { direction: "North", className: "north" },
  { direction: "NorthEast", className: "northEast" },
  { direction: "East", className: "east" },
  { direction: "SouthEast", className: "southEast" },
  { direction: "South", className: "south" },
  { direction: "SouthWest", className: "southWest" },
  { direction: "West", className: "west" },
];

/**
 * 无边框窗口的缩放手柄。Linux/GTK 的无边框窗口没有系统提供的 resize 边框，
 * 需要在窗口边缘放置透明热区，按下后调用 `startResizeDragging` 进入系统缩放。
 *
 * 层级关系（见 WindowControls.module.css）：
 * - 边缘热区（1000）低于标题栏拖拽区（1001）与窗口控制按钮（1002），
 *   顶部中间的拖拽、右侧按钮的点击都不会被边缘热区拦截；
 * - 四角热区（1003）高于控制按钮，保证窗口最角落始终可抓取缩放。
 */
export function WindowResizeHandles() {
  const startResize =
    (direction: ResizeDirection) => (event: MouseEvent<HTMLDivElement>) => {
      if (event.buttons !== 1) return;
      event.preventDefault();
      void windowCommands.startResizeDragging(direction).catch((error) => {
        console.error("Failed to start window resize dragging", error);
      });
    };

  return (
    <>
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={`${styles.handle} ${styles[className]}`}
          aria-hidden="true"
          data-testid={`resize-handle-${direction}`}
          onMouseDown={startResize(direction)}
        />
      ))}
    </>
  );
}
