import { describe, expect, it } from "vitest";
import {
  agentPrompt,
  downloadsUrl,
  formatBytes,
  installCommand,
  localAccessUrls,
  loginCommand,
  pullCommand,
} from "./localAccess";

describe("localAccess download URLs", () => {
  it("derives download URLs from the current origin", () => {
    expect(downloadsUrl()).toBe(`${window.location.origin}/downloads`);
    expect(localAccessUrls().skills).toBe(`${window.location.origin}/downloads/flowlet-skills.tar.gz`);
    expect(localAccessUrls().installScript).toBe(`${window.location.origin}/downloads/install-flowlet.sh`);
  });

  it("builds the one-line install command", () => {
    expect(installCommand("http://127.0.0.1:8080/downloads")).toBe(
      "curl -fsSL http://127.0.0.1:8080/downloads/install-flowlet.sh | sh -s -- --base=http://127.0.0.1:8080/downloads",
    );
  });

  it("builds the login command for browser authorization", () => {
    expect(loginCommand("http://127.0.0.1:8080")).toBe(
      "flowlet login --server=http://127.0.0.1:8080",
    );
  });

  it("builds the pull command without any admin token", () => {
    expect(pullCommand("http://127.0.0.1:8080")).toBe(
      "flowlet pull --server=http://127.0.0.1:8080",
    );
    expect(pullCommand("http://127.0.0.1:8080")).not.toContain("--token");
  });

  it("fills the Agent prompt template with install → login → pull → skills", () => {
    const prompt = agentPrompt("http://127.0.0.1:8080");
    expect(prompt).toContain("http://127.0.0.1:8080/downloads/install-flowlet.sh");
    expect(prompt).toContain("flowlet login --server=http://127.0.0.1:8080");
    expect(prompt).toContain("flowlet pull --server=http://127.0.0.1:8080");
    expect(prompt).toContain("http://127.0.0.1:8080/downloads/flowlet-skills.tar.gz");
    expect(prompt).toContain("flowlet list");
    expect(prompt).not.toContain("--token");
    // 顺序必须是 安装 → login → pull → Skills。
    expect(prompt.indexOf("1) 安装 CLI")).toBeLessThan(prompt.indexOf("2) 登录授权"));
    expect(prompt.indexOf("2) 登录授权")).toBeLessThan(prompt.indexOf("3) 同步凭据"));
    expect(prompt.indexOf("3) 同步凭据")).toBeLessThan(prompt.indexOf("4) 安装 Skills"));
  });
});

describe("formatBytes", () => {
  it("formats artifact sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatBytes(-1)).toBe("-");
  });
});