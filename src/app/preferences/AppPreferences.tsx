import { LocaleProvider } from "@douyinfe/semi-ui-19";
import enUS from "@douyinfe/semi-ui-19/lib/es/locale/source/en_US";
import zhCN from "@douyinfe/semi-ui-19/lib/es/locale/source/zh_CN";
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { translate, type AppLanguage, type TranslationVariables } from "./translations";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const LANGUAGE_KEY = "flowlet.language";
const THEME_KEY = "flowlet.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

type PreferencesValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  resolvedTheme: ResolvedTheme;
  t: (source: string, variables?: TranslationVariables) => string;
};

const fallback: PreferencesValue = {
  language: "zh-CN",
  setLanguage: () => undefined,
  theme: "system",
  setTheme: () => undefined,
  resolvedTheme: "light",
  t: (source, variables) => translate("zh-CN", source, variables),
};

const PreferencesContext = createContext<PreferencesValue>(fallback);

export function applyInitialPreferences() {
  const language = readLanguage();
  const theme = readTheme();
  applyDocumentPreferences(language, resolveTheme(theme));
}

export function AppPreferencesProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<AppLanguage>(readLanguage);
  const [theme, setThemeState] = useState<ThemePreference>(readTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    const update = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? "dark" : "light");
    setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => applyDocumentPreferences(language, resolvedTheme), [language, resolvedTheme]);

  const value = useMemo<PreferencesValue>(() => ({
    language,
    setLanguage(next) {
      setLanguageState(next);
      writePreference(LANGUAGE_KEY, next);
    },
    theme,
    setTheme(next) {
      setThemeState(next);
      writePreference(THEME_KEY, next);
    },
    resolvedTheme,
    t: (source, variables) => translate(language, source, variables),
  }), [language, resolvedTheme, theme]);

  return (
    <PreferencesContext.Provider value={value}>
      <LocaleProvider locale={language === "zh-CN" ? zhCN : enUS}>{children}</LocaleProvider>
    </PreferencesContext.Provider>
  );
}

export function useAppPreferences() {
  return useContext(PreferencesContext);
}

function readLanguage(): AppLanguage {
  const saved = readPreference(LANGUAGE_KEY);
  return saved === "zh-CN" || saved === "en-US" ? saved : resolveSystemLanguage();
}

export function resolveSystemLanguage(systemLanguage = typeof navigator === "undefined" ? "" : navigator.language): AppLanguage {
  return /^zh(?:[-_]|$)/i.test(systemLanguage.trim()) ? "zh-CN" : "en-US";
}

function readTheme(): ThemePreference {
  const value = readPreference(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function resolveTheme(theme: ThemePreference): ResolvedTheme {
  return theme === "system" ? readSystemTheme() : theme;
}

function applyDocumentPreferences(language: AppLanguage, theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.style.colorScheme = theme;
  document.body.setAttribute("theme-mode", theme);
}

function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences still apply for the current session when storage is unavailable.
  }
}
