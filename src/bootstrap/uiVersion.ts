import { invoke } from "@tauri-apps/api/core";

export type UiVersion = "legacy" | "next";

export function parseUiVersion(config: unknown): UiVersion {
  if (!config || typeof config !== "object") return "legacy";

  const ui = (config as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return "legacy";

  return (ui as { version?: unknown }).version === "next" ? "next" : "legacy";
}

export async function resolveUiVersion(fallback: UiVersion = "legacy"): Promise<UiVersion> {
  try {
    const configJson = await invoke<string>("read_config");
    return parseUiVersion(JSON.parse(configJson));
  } catch {
    return fallback;
  }
}