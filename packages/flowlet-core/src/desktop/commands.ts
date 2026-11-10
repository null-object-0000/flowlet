// 桌面命令注册表与 dispatch 入口。Owner: lead。
//
// 只有「Web Host 白名单之外」的桌面命令登记在这里；同名命令不允许两边各写一份，
// 确需桌面特化时在注册表里显式覆盖（`hasDesktopCommand` 优先于 web dispatch）。
import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { WebContext } from "../web/context.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import { handlers as agentHandlers } from "./agent.ts";
import { handlers as maintenanceHandlers } from "./maintenance.ts";
import { handlers as observabilityHandlers } from "./observability.ts";
import { handlers as deviceHandlers } from "./device.ts";
import { handlers as accountWorkspaceHandlers } from "./account-workspace.ts";
import { handlers as scrapeHandlers } from "./scrape.ts";

/** 全部桌面命令（领域文件合并；同名覆盖视为契约冲突，由测试兜底）。 */
const REGISTRY: DesktopHandlerMap = {
  ...agentHandlers,
  ...maintenanceHandlers,
  ...observabilityHandlers,
  ...deviceHandlers,
  ...accountWorkspaceHandlers,
  ...scrapeHandlers,
};

export function desktopCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

export function hasDesktopCommand(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, command);
}

/**
 * 执行一条桌面命令。调用方（`web/index.ts`）已确认 `ctx.desktop` 存在且命令已注册。
 */
export async function dispatchDesktop(
  ctx: WebContext,
  command: string,
  args: JsonRow,
): Promise<unknown> {
  const desktop = ctx.desktop;
  if (desktop === undefined) throw CommandError.notImplemented(command);
  const handler = REGISTRY[command];
  if (handler === undefined) throw CommandError.notImplemented(command);
  return handler(ctx as DesktopContext, args);
}