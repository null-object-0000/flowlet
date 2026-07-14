import { invoke } from "@tauri-apps/api/core";

export type CommandArguments = Record<string, unknown>;

export function invokeCommand<TResult>(
  command: string,
  args?: CommandArguments,
): Promise<TResult> {
  return invoke<TResult>(command, args);
}