import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const resetCss = readFileSync(resolve(process.cwd(), "src/styles/reset.css"), "utf8");
const lightScope = css.match(/:root\s*{([\s\S]*?)\n}/)?.[1] ?? "";
const darkScope = css.match(/body\[theme-mode="dark"\]\s*{([\s\S]*?)\n}/)?.[1] ?? "";
const sourceCss = collectCssFiles(resolve(process.cwd(), "src"))
  .filter(({ file }) => !file.replace(/\\/g, "/").includes("/src/mobile/"));

describe("readability color tokens", () => {
  it("keeps the primary text alias tied to the tested primary text color", () => {
    expect(lightScope).toMatch(/--flowlet-color-text-primary:\s*var\(--flowlet-color-text\);/);
  });

  it.each([
    ["light primary on app", lightScope, "--flowlet-color-text", lightScope, "--flowlet-color-app-bg"],
    ["light primary on muted", lightScope, "--flowlet-color-text", lightScope, "--flowlet-color-surface-muted"],
    ["light primary on strong", lightScope, "--flowlet-color-text", lightScope, "--flowlet-color-surface-strong"],
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
    ["dark primary on muted", darkScope, "--flowlet-color-text", darkScope, "--flowlet-color-surface-muted"],
    ["dark primary on strong", darkScope, "--flowlet-color-text", darkScope, "--flowlet-color-surface-strong"],
  ])("keeps %s at WCAG AA contrast", (_label, foregroundScope, foregroundName, backgroundScope, backgroundName) => {
    const foreground = readHexToken(foregroundScope, foregroundName);
    const background = readHexToken(backgroundScope, backgroundName);

    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Flowlet design token references", () => {
  it("defines every Flowlet token that is used without a fallback", () => {
    const definitions = new Set(
      sourceCss.flatMap(({ content }) => [...content.matchAll(/(--flowlet-[a-z0-9-]+)\s*:/gi)].map((match) => match[1])),
    );
    const missing = sourceCss.flatMap(({ file, content }) =>
      [...content.matchAll(/var\((--flowlet-[a-z0-9-]+)([^)]*)\)/gi)]
        .filter((match) => !definitions.has(match[1]) && !match[2].includes(","))
        .map((match) => `${file}: ${match[1]}`),
    );

    expect(missing).toEqual([]);
  });
});

describe("typography reset", () => {
  it("keeps native form controls on the same font as surrounding Flowlet text", () => {
    expect(resetCss).toMatch(/button,[\s\S]*?input,[\s\S]*?textarea,[\s\S]*?select\s*{[\s\S]*?font:\s*inherit;/);
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

function collectCssFiles(directory: string): Array<{ file: string; content: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectCssFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".css")) return [];
    return [{ file: path, content: readFileSync(path, "utf8") }];
  });
}
