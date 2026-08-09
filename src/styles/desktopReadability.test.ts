import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migratedDesktopStyles = [
  "src/app/shell/Nav.module.css",
  "src/app/shell/Sidebar.module.css",
  "src/pages/task-logs/TaskLogsPage.module.css",
  "src/pages/settings/SettingRow.module.css",
  "src/pages/settings/SettingsPageStatic.module.css",
  "src/pages/settings/tabs/MaintenanceTab.module.css",
  "src/pages/settings/tabs/StorageTab.module.css",
  "src/pages/settings/tabs/SyncTab.module.css",
  "src/shared/ui/RefreshControl.module.css",
  "src/shared/ui/TokenBreakdownTooltip.module.css",
];

describe("migrated desktop readability styles", () => {
  it.each(migratedDesktopStyles)("keeps business text at or above the 12px caption floor in %s", (file) => {
    const css = readFileSync(resolve(process.cwd(), file), "utf8");
    const pixelFontSizes = [
      ...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g),
      ...css.matchAll(/font:\s*(\d+(?:\.\d+)?)px\//g),
    ].map((match) => Number(match[1]));

    expect(pixelFontSizes.every((fontSize) => fontSize >= 12)).toBe(true);
  });

  it("keeps dense task and storage rows on the compact body scale", () => {
    const taskLogsCss = readFileSync(resolve(process.cwd(), "src/pages/task-logs/TaskLogsPage.module.css"), "utf8");
    const storageCss = readFileSync(resolve(process.cwd(), "src/pages/settings/tabs/StorageTab.module.css"), "utf8");

    expect(taskLogsCss).toMatch(/\.row\s*{[^}]*font-size:\s*var\(--flowlet-font-size-body-compact\)/);
    expect(storageCss).toMatch(/\.table\s*{[^}]*font-size:\s*var\(--flowlet-font-size-body-compact\)/);
  });

  it("keeps project card timing and queue metadata on one line", () => {
    const projectsCss = readFileSync(resolve(process.cwd(), "src/pages/projects/ProjectsPage.module.css"), "utf8");

    expect(projectsCss).toMatch(/\.taskCardMetaRight\s*{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap;/);
    expect(projectsCss).toMatch(/\.taskCardTime\s*{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap;/);
  });
});
