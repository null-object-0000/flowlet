import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MobileDevicePicker } from "./MobileDevicePicker";
import { useMobileDeviceSelection } from "./MobileDeviceSelection";
import { MobileShell } from "./MobileShell";

vi.mock("../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => ({
    data: [{ deviceId: "device-1", displayName: "Office PC" }],
  }),
  useMobileDeviceSyncBackground: () => {},
}));

function SelectionPage({ name }: { name: string }) {
  const navigate = useNavigate();
  const { deviceId } = useMobileDeviceSelection();
  return (
    <section>
      <span>{name}</span>
      <MobileDevicePicker />
      <output aria-label="selected-device">{deviceId ?? "all"}</output>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </section>
  );
}

describe("MobileShell", () => {
  it("shares the selected device and replaces tab navigation history", () => {
    render(
      <MemoryRouter initialEntries={["/origin", "/"]} initialIndex={1}>
        <Routes>
          <Route path="/origin" element={<span>Origin</span>} />
          <Route element={<MobileShell />}>
            <Route path="/" element={<SelectionPage name="Overview page" />} />
            <Route path="/projects" element={<SelectionPage name="Projects page" />} />
            <Route path="/devices" element={<span>Devices page</span>} />
            <Route path="/settings" element={<span>Settings page</span>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "概览",
      "项目",
      "设备",
      "设置",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "切换设备，当前：全部设备" }));
    fireEvent.click(screen.getByText("Office PC"));
    expect(screen.getByLabelText("selected-device")).toHaveTextContent("device-1");

    fireEvent.click(within(navigation).getByText("项目").closest("a")!);
    expect(screen.getByText("Projects page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换设备，当前：Office PC" })).toBeInTheDocument();
    expect(screen.getByLabelText("selected-device")).toHaveTextContent("device-1");

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByText("Origin")).toBeInTheDocument();
  });
});
