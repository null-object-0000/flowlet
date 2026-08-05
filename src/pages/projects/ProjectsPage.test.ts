import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { computeTaskBoardColumns } from "./ProjectsPage";

describe("computeTaskBoardColumns", () => {
  it("keeps 3 columns on the default 1200px window with sidebar", () => {
    // 1200 窗口 - 188 侧边栏 - 2×16 页边距 = 980px 内容宽度，恰好 3 列。
    expect(computeTaskBoardColumns(980)).toBe(3);
  });

  it("shows a 4th column once the container can fit it", () => {
    // 4 列最小需要 4×240 + 3×12 = 996px。
    expect(computeTaskBoardColumns(996)).toBe(4);
    expect(computeTaskBoardColumns(995)).toBe(3);
  });

  it("never drops below 3 columns when space is tight", () => {
    expect(computeTaskBoardColumns(600)).toBe(3);
    expect(computeTaskBoardColumns(0)).toBe(3);
  });

  it("caps at 4 columns on very wide windows", () => {
    expect(computeTaskBoardColumns(2000)).toBe(4);
  });
});
