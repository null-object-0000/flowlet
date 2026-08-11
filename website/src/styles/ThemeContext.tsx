import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { syncThemeMode } from "./theme";

export type ThemeMode = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "flowlet-website-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeValue {
  mode: ThemeMode;
  effective: EffectiveTheme;
  /** 设置为显式主题并持久化;传 "system" 时清除持久化,回到跟随系统。 */
  setMode: (mode: ThemeMode) => void;
  /** 在浅色/深色间切换(第一次点击即从系统默认转为显式选择)。 */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue>({
  mode: "system",
  effective: "light",
  setMode: () => {},
  toggle: () => {},
});

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore storage errors */
  }
  return "system";
}

function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [sysDark, setSysDark] = useState<boolean>(systemDark);

  // 跟随系统外观变化(仅当 mode === "system" 时生效)。
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const listener = (event: MediaQueryListEvent) => setSysDark(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const effective: EffectiveTheme = mode === "system" ? (sysDark ? "dark" : "light") : mode;

  // useLayoutEffect 在绘制前应用,避免首屏闪白/闪黑。
  useLayoutEffect(() => {
    syncThemeMode(effective === "dark");
  }, [effective]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      if (next === "system") {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      /* ignore storage errors */
    }
  }

  function toggle() {
    setMode(effective === "dark" ? "light" : "dark");
  }

  const value: ThemeValue = { mode, effective, setMode, toggle };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}