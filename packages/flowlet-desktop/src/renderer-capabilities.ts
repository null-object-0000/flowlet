import type { OpenDialogOptions, SaveDialogOptions } from "electron";

export type HostEventName = "agent-source-changed" | "storage-usage-progress";

/** Host-internal event channel; payloads never select renderer IPC channels. */
export function parseHostEvent(raw: Record<string, unknown>): { event: HostEventName; payload: unknown } {
  const event = raw["event"];
  if (event !== "agent-source-changed" && event !== "storage-usage-progress") {
    throw new Error(`不支持的宿主事件：${String(event)}`);
  }
  if (event === "storage-usage-progress") {
    const payload = raw["payload"];
    if (!payload || typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>)["scanId"] !== "string" ||
        !(payload as Record<string, unknown>)["summary"] ||
        typeof (payload as Record<string, unknown>)["summary"] !== "object") {
      throw new Error("storage-usage-progress 需要 scanId 与 summary");
    }
  }
  return { event, payload: raw["payload"] };
}

function dialogOptions(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("文件对话框参数必须是对象");
  return raw as Record<string, unknown>;
}

function normalizeDialogFilters(raw: unknown): { name: string; extensions: string[] }[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 32) throw new Error("无效的文件过滤器");
  return raw.map((item: unknown) => {
    const filter = dialogOptions(item);
    const name = filter["name"];
    const extensions = filter["extensions"];
    if (typeof name !== "string" || !Array.isArray(extensions) || extensions.length === 0 ||
        extensions.some((ext) => typeof ext !== "string" || !/^(?:[a-zA-Z0-9_-]+|\*)$/.test(ext))) {
      throw new Error("无效的文件过滤器");
    }
    return { name, extensions: extensions as string[] };
  });
}

function baseOptions(raw: Record<string, unknown>): SaveDialogOptions {
  return {
    title: typeof raw["title"] === "string" ? raw["title"] : undefined,
    defaultPath: typeof raw["defaultPath"] === "string" ? raw["defaultPath"] : undefined,
    filters: normalizeDialogFilters(raw["filters"]),
  };
}

/** Two fixed renderer methods, with sender and local-Host checks on every call. */
export function registerDialogHandlers<E, W>(deps: {
  handle: (channel: string, handler: (event: E, options: unknown) => Promise<unknown>) => void;
  fromMainWindow: (event: E) => W;
  isHostMode: () => boolean;
  open: (window: W, options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  save: (window: W, options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
}): void {
  const authorize = (event: E): W => {
    const window = deps.fromMainWindow(event);
    if (!deps.isHostMode()) throw new Error("客户端模式不提供本机文件对话框");
    return window;
  };
  deps.handle("dialog:open", async (event, raw) => {
    const window = authorize(event);
    const options = dialogOptions(raw);
    const result = await deps.open(window, {
      ...baseOptions(options),
      properties: [
        options["directory"] === true ? "openDirectory" : "openFile",
        ...(options["multiple"] === true ? ["multiSelections" as const] : []),
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return options["multiple"] === true ? result.filePaths : result.filePaths[0];
  });
  deps.handle("dialog:save", async (event, raw) => {
    const window = authorize(event);
    const result = await deps.save(window, baseOptions(dialogOptions(raw)));
    return result.canceled ? null : (result.filePath ?? null);
  });
}
