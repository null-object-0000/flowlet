/** 与主应用 AppPreferences 使用同一 theme-mode 机制。 */
export function syncThemeMode(matchesDark: boolean): void {
  if (matchesDark) {
    document.documentElement.setAttribute("theme-mode", "dark");
    document.body.setAttribute("theme-mode", "dark");
  } else {
    document.documentElement.removeAttribute("theme-mode");
    document.body.removeAttribute("theme-mode");
  }
}
