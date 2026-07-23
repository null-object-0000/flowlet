import { describe, expect, it } from "vitest";
import { formatFullTimestamp, formatTimestamp, parseTimestamp } from "./datetime";

describe("parseTimestamp", () => {
  it("accepts ISO 8601 values unchanged", () => {
    expect(parseTimestamp("2026-07-21T06:05:09Z")?.getTime()).toBe(new Date("2026-07-21T06:05:09Z").getTime());
  });

  it("normalizes legacy SQLite values as UTC", () => {
    expect(parseTimestamp("2026-07-21 06:05:09")?.getTime()).toBe(new Date("2026-07-21T06:05:09Z").getTime());
  });

  it("returns null for unparseable values", () => {
    expect(parseTimestamp("not-a-date")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  // Assertions stay timezone-independent: only the rendered shape and the
  // SQLite/ISO equivalence are checked, never absolute clock values.
  it("renders zh-CN values as month/day plus time down to seconds", () => {
    expect(formatTimestamp("2026-07-21T06:05:09Z", "zh-CN")).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("renders en-US values as month/day plus time down to seconds", () => {
    expect(formatTimestamp("2026-07-21T06:05:09Z", "en-US")).toMatch(/^\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}$/);
  });

  it("omits the year", () => {
    expect(formatTimestamp("2026-07-21T06:05:09Z", "zh-CN")).not.toContain("2026");
  });

  it("formats SQLite and ISO spellings of the same instant identically", () => {
    expect(formatTimestamp("2026-07-21 06:05:09", "zh-CN")).toBe(formatTimestamp("2026-07-21T06:05:09Z", "zh-CN"));
  });

  it("passes unparseable values through unchanged", () => {
    expect(formatTimestamp("not-a-date", "zh-CN")).toBe("not-a-date");
  });
});

describe("formatFullTimestamp", () => {
  it("converts a UTC synchronization instant to the requested timezone", () => {
    expect(formatFullTimestamp("2026-07-23T04:35:26Z", "zh-CN", "Asia/Shanghai"))
      .toBe("2026/07/23 12:35:26");
  });

  it("passes unparseable values through unchanged", () => {
    expect(formatFullTimestamp("not-a-date", "zh-CN")).toBe("not-a-date");
  });
});
