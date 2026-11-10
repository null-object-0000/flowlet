import type { MouseEvent } from "react";
import { requireDesktopWindowBridge } from "../../platform/desktop/bridge";
import { isDesktopHost } from "../../platform/desktop/mode";
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
 * Electron desktop（HG-2 降级实现）：没有 Tauri `startResizeDragging(direction)`
 * 的等价 API。这里把方向 + 初始屏幕坐标交给 preload 桥的 `resizeBegin`，
 * preload 随后把 pointermove/pointerup 转发为 `window:resize-move` /
 * `window:resize-end`，主进程用 `setBounds` 跟随（无系统 resize 模态与窗口吸附）。
 * 渲染进程再补一次 `mouseup`/`blur` 的 `resizeEnd` 作为兜底（主进程实现必须幂等）。
 */
async function resizeDesktopWindow(
  direction: ResizeDirection,
  screenX: number,
  screenY: number,
) {
  const bridge = requireDesktopWindowBridge();
  await bridge.resizeBegin({ direction, screenX, screenY });
  await new Promise<void>((resolve) => {
    const finish = () => {
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      resolve();
    };
    window.addEventListener("mouseup", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  });
  await bridge.resizeEnd();
}

/**
 * 无边框窗口的缩放手柄。Linux/GTK 的无边框窗口没有系统提供的 resize 边框，
 * 需要在窗口边缘放置透明热区：Tauri 调用 `startResizeDragging` 进入系统缩放；
 * Electron desktop 走 preload 桥的 `resizeBegin`（主进程 setBounds 跟随）。
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
      if (isDesktopHost) {
        void resizeDesktopWindow(direction, event.screenX, event.screenY).catch((error) => {
          console.error("Failed to resize the window through the desktop bridge", error);
        });
        return;
      }
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