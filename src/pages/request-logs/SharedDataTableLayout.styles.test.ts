import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSharedCss = (name: string) => readFileSync(resolve(process.cwd(), `packages/product-ui/src/desktop/${name}.module.css`), "utf8");

describe("shared request and session table layouts", () => {
  it("reserves an explicit grid row for the request-log toolbar", () => {
    expect(readSharedCss("RequestLogsView")).toContain(".page:has(.toolbarSlot) { grid-template-rows: auto auto minmax(0, 1fr); }");
  });

  it("keeps request-log totals on the left and pagination on the right", () => {
    const css = readSharedCss("RequestLogsView");

    expect(css).toContain("justify-content: space-between");
    expect(css).toContain(".tableFooter :global(.semi-page) { flex: none; margin-left: auto; }");
  });

  it("reserves an explicit grid row for the session toolbar", () => {
    expect(readSharedCss("AgentSessionsView")).toContain(".page:has(.toolbarSlot) { grid-template-rows: auto minmax(0, 1fr); }");
  });
});
