import { describe, expect, it } from "vitest";
import type { AgentEnvironmentReport } from "./types";
import { cliInstalledVersion, compareVersions, isNewerVersion } from "./versions";

function cliInstall(version: string): AgentEnvironmentReport["installations"][number] {
  return {
    surface: "cli",
    executable_path: "C:\\cli\\bin.exe",
    install_dir: "C:\\cli",
    install_method: "npm",
    version,
    available_on_path: true,
  };
}

function desktopInstall(version: string): AgentEnvironmentReport["installations"][number] {
  return {
    surface: "desktop",
    executable_path: "C:\\desktop\\app.exe",
    install_dir: "C:\\desktop",
    install_method: "desktop",
    version,
    available_on_path: false,
  };
}

describe("compareVersions", () => {
  it("比较常规版本号", () => {
    expect(compareVersions("2.1.221", "2.1.207")).toBe(1);
    expect(compareVersions("1.18.13", "1.18.2")).toBe(1);
    expect(compareVersions("0.83.0", "0.42.1")).toBe(1);
    expect(compareVersions("0.146.0", "0.146.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });

  it("处理缺失段与零填充", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.0")).toBe(1);
  });

  it("处理 v 前缀", () => {
    expect(compareVersions("v2.1.0", "2.0.9")).toBe(1);
  });

  it("处理 pre-release（无 pre > 有 pre）", () => {
    expect(compareVersions("2.1.0", "2.1.0-beta.1")).toBe(1);
    expect(compareVersions("2.1.0-beta.2", "2.1.0-beta.1")).toBe(1);
    expect(compareVersions("2.1.0-alpha", "2.1.0-beta")).toBe(-1);
  });

  it("无法解析时按字符串兜底", () => {
    expect(compareVersions("abc", "def")).toBe(-1);
    expect(compareVersions("x", "x")).toBe(0);
  });

  it("空值参与比较时按字符串兜底", () => {
    expect(compareVersions(null, null)).toBe(0);
    expect(compareVersions("1.0.0", undefined)).toBe(1);
  });
});

describe("isNewerVersion", () => {
  it("有新版本返回 true", () => {
    expect(isNewerVersion("2.1.221", "2.1.207")).toBe(true);
  });

  it("相同或更旧返回 false", () => {
    expect(isNewerVersion("2.1.207", "2.1.207")).toBe(false);
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
  });

  it("任一侧为空返回 false", () => {
    expect(isNewerVersion(null, "2.1.207")).toBe(false);
    expect(isNewerVersion("2.1.221", null)).toBe(false);
    expect(isNewerVersion(undefined, undefined)).toBe(false);
  });
});

describe("cliInstalledVersion", () => {
  it("优先取「当前使用」的 CLI 安装版本", () => {
    const report: AgentEnvironmentReport = {
      agent_id: "codex",
      agent_name: "Codex",
      installed: true,
      primary: cliInstall("0.142.5"),
      installations: [cliInstall("0.142.5"), desktopInstall("26.707.12708.0")],
    };
    expect(cliInstalledVersion(report)).toBe("0.142.5");
  });

  it("primary 是桌面应用时回退到首个 CLI 安装版本", () => {
    const report: AgentEnvironmentReport = {
      agent_id: "codex",
      agent_name: "Codex",
      installed: true,
      primary: desktopInstall("26.707.12708.0"),
      installations: [desktopInstall("26.707.12708.0"), cliInstall("0.146.0")],
    };
    expect(cliInstalledVersion(report)).toBe("0.146.0");
  });

  it("只有桌面安装、无 CLI 时返回 null（不展示更新提示）", () => {
    const report: AgentEnvironmentReport = {
      agent_id: "opencode",
      agent_name: "OpenCode",
      installed: true,
      primary: desktopInstall("1.0.0"),
      installations: [desktopInstall("1.0.0")],
    };
    expect(cliInstalledVersion(report)).toBeNull();
  });

  it("无 surface 字段视为 CLI（Claude Code / Pi）", () => {
    const report: AgentEnvironmentReport = {
      agent_id: "claude-code",
      agent_name: "Claude Code",
      installed: true,
      primary: { ...cliInstall("2.1.221"), surface: undefined },
      installations: [{ ...cliInstall("2.1.221"), surface: undefined }],
    };
    expect(cliInstalledVersion(report)).toBe("2.1.221");
  });

  it("空报告返回 null", () => {
    expect(cliInstalledVersion(undefined)).toBeNull();
  });
});
