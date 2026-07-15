import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

import { AppPreferencesProvider, applyInitialPreferences, resolveSystemLanguage, useAppPreferences } from "./AppPreferences";

afterEach(() => {
  localStorage.clear();
  document.body.removeAttribute("theme-mode");
  vi.restoreAllMocks();
});

describe("AppPreferencesProvider", () => {
  it.each(["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hans", "zh-Hant-TW", "ZH_hant_HK"])(
    "uses Chinese for the %s system locale",
    (systemLanguage) => {
      expect(resolveSystemLanguage(systemLanguage)).toBe("zh-CN");
    },
  );

  it.each(["en-US", "en-GB", "ja-JP", "ko-KR", "fr-FR", ""])(
    "uses English for the %s system locale",
    (systemLanguage) => {
      expect(resolveSystemLanguage(systemLanguage)).toBe("en-US");
    },
  );

  it("uses the system language when no preference has been saved", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("zh-TW");
    applyInitialPreferences();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("restores persisted language and theme before rendering", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("zh-TW");
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
