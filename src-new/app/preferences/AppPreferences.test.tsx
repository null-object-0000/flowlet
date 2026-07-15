import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppPreferencesProvider, applyInitialPreferences, useAppPreferences } from "./AppPreferences";

afterEach(() => {
  localStorage.clear();
  document.body.removeAttribute("theme-mode");
  vi.restoreAllMocks();
});

describe("AppPreferencesProvider", () => {
  it("restores persisted language and theme before rendering", () => {
    localStorage.setItem("flowlet.language", "en-US");
    localStorage.setItem("flowlet.theme", "dark");
    applyInitialPreferences();

    expect(document.documentElement.lang).toBe("en-US");
    expect(document.body).toHaveAttribute("theme-mode", "dark");
  });

  it("switches language and theme immediately and persists them", () => {
    render(<AppPreferencesProvider><PreferenceProbe /></AppPreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: "english" }));
    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(document.body).toHaveAttribute("theme-mode", "dark");
    expect(localStorage.getItem("flowlet.language")).toBe("en-US");
    expect(localStorage.getItem("flowlet.theme")).toBe("dark");
  });
});

function PreferenceProbe() {
  const { setLanguage, setTheme, t } = useAppPreferences();
  return <><span>{t("设置")}</span><button onClick={() => setLanguage("en-US")}>english</button><button onClick={() => setTheme("dark")}>dark</button></>;
}

