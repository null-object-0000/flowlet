import { ActionIcon, Group } from "@mantine/core";
import { IconMaximize, IconMinus, IconX } from "@tabler/icons-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export function WindowControls() {
  function startWindowDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void appWindow.startDragging();
  }

  return (
    <>
      <div
        className="window-drag-region"
        onPointerDown={startWindowDrag}
        role="presentation"
      />
      <Group className="window-controls" gap={2} wrap="nowrap">
        <ActionIcon
          className="window-control-button"
          variant="subtle"
          color="gray"
          aria-label="最小化"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void appWindow.minimize()}
        >
          <IconMinus size={15} stroke={1.9} />
        </ActionIcon>
        <ActionIcon
          className="window-control-button"
          variant="subtle"
          color="gray"
          aria-label="最大化"
          disabled
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IconMaximize size={14} stroke={1.9} />
        </ActionIcon>
        <ActionIcon
          className="window-control-button window-control-close"
          variant="subtle"
          color="gray"
          aria-label="关闭"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void appWindow.close()}
        >
          <IconX size={15} stroke={1.9} />
        </ActionIcon>
      </Group>
    </>
  );
}
