import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NAME_MAX_DISPLAY_UNITS,
  getAccountNameDisplayUnits,
  truncateAccountName,
} from "./accountName";

describe("account name display limit", () => {
  it("allows twenty narrow characters", () => {
    const value = "12345678901234567890";
    expect(ACCOUNT_NAME_MAX_DISPLAY_UNITS).toBe(20);
    expect(getAccountNameDisplayUnits(value)).toBe(20);
    expect(truncateAccountName(value)).toBe(value);
  });

  it("still counts wide characters as two display units", () => {
    expect(truncateAccountName("一二三四五六七八九十甲")).toBe("一二三四五六七八九十");
    expect(getAccountNameDisplayUnits("一二三四五六七八九十")).toBe(20);
  });
});
