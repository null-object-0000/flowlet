// 运行模式设置窗口的 preload（dist-host/preload-mode.cjs）。
//
// 只在「连接主机 / 切换运行模式」小窗口里注入；不暴露 ipcRenderer、不给主窗口用。
import { contextBridge, ipcRenderer } from "electron";

export interface ModeWindowApi {
  load(): Promise<unknown>;
  test(payload: { baseUrl: string; authKind: "token" | "session"; token?: string }): Promise<unknown>;
  save(payload: {
    mode: "host" | "client";
    baseUrl?: string;
    authKind?: "token" | "session";
    token?: string;
  }): Promise<unknown>;
  login(payload: { baseUrl: string }): Promise<unknown>;
  close(): Promise<void>;
}

const api: ModeWindowApi = {
  load: () => ipcRenderer.invoke("mode:load"),
  test: (payload) => ipcRenderer.invoke("mode:test", payload),
  save: (payload) => ipcRenderer.invoke("mode:save", payload),
  login: (payload) => ipcRenderer.invoke("mode:login", payload),
  close: () => ipcRenderer.invoke("mode:close"),
};

contextBridge.exposeInMainWorld("flowletMode", api);
