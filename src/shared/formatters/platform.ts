/**
 * 设备平台标签。后端 `platform` 字段保存稳定的小写键：桌面系统用
 * `windows` / `macos` / `linux`，Linux 发行版用 `/etc/os-release` 的 `ID`
 * （如 `ubuntu`、`debian`），移动端用 `android` / `ios`。
 */
const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  darwin: "macOS",
  macos: "macOS",
  linux: "Linux",
  ubuntu: "Ubuntu",
  debian: "Debian",
  fedora: "Fedora",
  arch: "Arch",
  manjaro: "Manjaro",
  linuxmint: "Linux Mint",
  centos: "CentOS",
  rhel: "RHEL",
  alpine: "Alpine",
  opensuse: "openSUSE",
  "opensuse-leap": "openSUSE",
  "opensuse-tumbleweed": "openSUSE",
  android: "Android",
  ios: "iOS",
};

/**
 * 把设备 platform 键映射为展示用标签。未知发行版 ID 退化为首字母大写，
 * 空值或 `unknown` 返回空串，由调用方决定兜底文案（桌面 "Flowlet"、
 * 移动端 "Desktop"）。
 */
export function platformLabel(platform: string): string {
  const value = (platform ?? "").trim().toLowerCase();
  if (!value || value === "unknown") return "";
  const known = PLATFORM_LABELS[value];
  if (known) return known;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
