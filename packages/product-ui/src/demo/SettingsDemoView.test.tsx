import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsDemoView } from "./SettingsDemoView";

describe("SettingsDemoView", () => {
  it("switches between populated settings categories", () => {
    render(<SettingsDemoView zh appVersion="test-version" />);
    expect(screen.getByText("开机自动启动")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "数据捕获" }));
    expect(screen.getByText("记录请求与响应 Body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "维护" }));
    expect(screen.getByText("数据完整性检查")).toBeTruthy();
  });
});
