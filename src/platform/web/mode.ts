import { isDesktopClient } from "../desktop/mode";

/**
 * True when the frontend runs against a remote Web Host:
 * - 浏览器里的 Web Host 构建（`vite --mode web`）；
 * - Electron 客户端模式（`mode === "client"`）：本机只跑 Client Gateway，
 *   命令与登录语义与 Web Host 完全一致，本机桌面能力全部隐藏。
 */
export const isWebHost = import.meta.env.MODE === "web" || isDesktopClient;
