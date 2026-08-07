import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const lightScope = css.match(/:root\s*{([\s\S]*?)\n}/)?.[1] ?? "";
const darkScope = css.match(/body\[theme-mode="dark"\]\s*{([\s\S]*?)\n}/)?.[1] ?? "";

describe("readability color tokens", () => {
  it.each([
    ["light secondary on app", lightScope, "--flowlet-color-text-secondary", lightScope, "--flowlet-color-app-bg"],
    ["light secondary on muted", lightScope, "--flowlet-color-text-secondary", lightScope, "--flowlet-color-surface-muted"],
    ["light secondary on strong", lightScope, "--flowlet-color-text-secondary", lightScope, "--flowlet-color-surface-strong"],
    ["light tertiary on app", lightScope, "--flowlet-color-text-tertiary", lightScope, "--flowlet-color-app-bg"],
    ["light tertiary on muted", lightScope, "--flowlet-color-text-tertiary", lightScope, "--flowlet-color-surface-muted"],
    ["light tertiary on strong", lightScope, "--flowlet-color-text-tertiary", lightScope, "--flowlet-color-surface-strong"],
    ["dark secondary on muted", darkScope, "--flowlet-color-text-secondary", darkScope, "--flowlet-color-surface-muted"],
    ["dark secondary on strong", darkScope, "--flowlet-color-text-secondary", darkScope, "--flowlet-color-surface-strong"],
    ["dark tertiary on muted", darkScope, "--flowlet-color-text-tertiary", darkScope, "--flowlet-color-surface-muted"],
    ["dark tertiary on strong", darkScope, "--flowlet-color-text-tertiary", darkScope, "--flowlet-color-surface-strong"],
  ])("keeps %s at WCAG AA contrast", (_label, foregroundScope, foregroundName, backgroundScope, backgroundName) => {
    const foreground = readHexToken(foregroundScope, foregroundName);
    const background = readHexToken(backgroundScope, backgroundName);

    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

function readHexToken(scope: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = scope.match(new RegExp(`${escapedName}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing opaque hex token ${name}`);
  return value;
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
