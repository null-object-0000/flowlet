const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 与主应用 AppPreferences 同一机制:通过 body theme-mode 属性驱动 Semi 与 Flowlet tokens 的暗色。 */
export function syncThemeMode(matchesDark: boolean): void {
  if (matchesDark) {
    document.body.setAttribute("theme-mode", "dark");
  } else {
    document.body.removeAttribute("theme-mode");
  }
}

/** 跟随系统外观切换,返回取消监听函数。 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY);
  syncThemeMode(media.matches);
  const listener = (event: MediaQueryListEvent) => syncThemeMode(event.matches);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
