import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NAME_MAX_DISPLAY_UNITS,
  getAccountNameDisplayUnits,
  truncateAccountName,
} from "./accountName";

describe("account name display limit", () => {
  it("allows thirty-two narrow characters", () => {
    const value = "12345678901234567890123456789012";
    expect(ACCOUNT_NAME_MAX_DISPLAY_UNITS).toBe(32);
    expect(getAccountNameDisplayUnits(value)).toBe(32);
    expect(truncateAccountName(value)).toBe(value);
  });

  it("still counts wide characters as two display units", () => {
    expect(truncateAccountName("一二三四五六七八九十甲乙丙丁戊己庚")).toBe("一二三四五六七八九十甲乙丙丁戊己");
    expect(getAccountNameDisplayUnits("一二三四五六七八九十甲乙丙丁戊己")).toBe(32);
  });
});
