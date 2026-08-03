import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppPreferencesProvider } from "../../app/preferences/AppPreferences";
import { DeviceUsageTitlePicker } from "../../features/device-sync/DeviceUsageTitlePicker";

describe("usage overview device title picker", () => {
  it("shows the current scope in the page title and switches devices", async () => {
    const onChange = vi.fn();
    const devices = [
      { deviceId: "office", displayName: "Office PC" },
      { deviceId: "home", displayName: "Home PC" },
    ];
    const { rerender } = render(
      <AppPreferencesProvider>
        <DeviceUsageTitlePicker devices={devices} deviceId={null} title="用量统计" onChange={onChange} />
      </AppPreferencesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch device, current: All devices" }));
    fireEvent.click(await screen.findByText("Office PC"));
    expect(onChange).toHaveBeenCalledWith("office");

    rerender(
      <AppPreferencesProvider>
        <DeviceUsageTitlePicker devices={devices} deviceId="office" title="用量统计" onChange={onChange} />
      </AppPreferencesProvider>,
    );
    expect(screen.getByRole("button", { name: "Switch device, current: Office PC" }))
      .toHaveTextContent("Office PC · Usage");
  });
});
