import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

import { AppPreferencesProvider, applyInitialPreferences, resolveSystemLanguage, useAppPreferences } from "./AppPreferences";
import { formatCompactNumber, getActiveTokenUnit, setActiveTokenUnit } from "../../shared/formatters/number";
import { translate } from "./translations";

afterEach(() => {
  localStorage.clear();
  document.body.removeAttribute("theme-mode");
  setActiveTokenUnit("auto");
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

  it("uses compact English labels in the overview", () => {
    expect(translate("en-US", "渠道账号")).toBe("Accounts");
    expect(translate("en-US", "已启用 {enabled} / 共 {total} 个账号", { enabled: 5, total: 7 })).toBe("5/7 enabled");
    expect(translate("en-US", "开放模型")).toBe("Models");
    expect(translate("en-US", "AI Agent 接入")).toBe("Agents");
    expect(translate("en-US", "ChatGPT (Codex) Desktop 接入")).toBe("ChatGPT Desktop");
    expect(translate("en-US", "添加 / 重新授权账号")).toBe("Add / reauthorize");
  });

  it("defaults the token unit to follow the interface language", () => {
    render(<AppPreferencesProvider><PreferenceProbe /></AppPreferencesProvider>);
    expect(getActiveTokenUnit()).toBe("auto");
    expect(formatCompactNumber(1_200_000, "zh-CN")).toBe("120.00万");
    expect(formatCompactNumber(1_200_000, "en-US")).toBe("1.20M");
  });

  it("switches and persists the token display unit", () => {
    render(<AppPreferencesProvider><PreferenceProbe /></AppPreferencesProvider>);
    fireEvent.click(screen.getByRole("button", { name: "en unit" }));

    expect(localStorage.getItem("flowlet.tokenUnit")).toBe("en");
    expect(getActiveTokenUnit()).toBe("en");
    expect(formatCompactNumber(1_200_000, "zh-CN")).toBe("1.20M");
  });

  it("restores a persisted token unit before rendering", () => {
    localStorage.setItem("flowlet.tokenUnit", "zh");
    render(<AppPreferencesProvider><PreferenceProbe /></AppPreferencesProvider>);

    expect(getActiveTokenUnit()).toBe("zh");
    expect(formatCompactNumber(1_200_000, "en-US")).toBe("120.00万");
  });
});

function PreferenceProbe() {
  const { setLanguage, setTheme, setTokenUnit, t } = useAppPreferences();
  return (
    <>
      <span>{t("设置")}</span>
      <button onClick={() => setLanguage("en-US")}>english</button>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTokenUnit("en")}>en unit</button>
      <button onClick={() => setTokenUnit("zh")}>zh unit</button>
    </>
  );
}
