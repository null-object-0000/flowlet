import { describe, expect, it } from "vitest";
import {
  followSessionScrollBottom,
  isSessionScrollNearBottom,
} from "./sessionScroll";

describe("sessionScroll", () => {
  it("treats the bottom tolerance as following latest content", () => {
    expect(isSessionScrollNearBottom({ scrollHeight: 600, clientHeight: 300, scrollTop: 268 })).toBe(true);
    expect(isSessionScrollNearBottom({ scrollHeight: 600, clientHeight: 300, scrollTop: 267 })).toBe(false);
  });

  it("moves to new content only when the user was already following the bottom", () => {
    const following = { scrollHeight: 760, clientHeight: 300, scrollTop: 300 };
    expect(followSessionScrollBottom(following, true)).toBe(true);
    expect(following.scrollTop).toBe(760);

    const readingHistory = { scrollHeight: 760, clientHeight: 300, scrollTop: 120 };
    expect(followSessionScrollBottom(readingHistory, false)).toBe(false);
    expect(readingHistory.scrollTop).toBe(120);
  });
});
