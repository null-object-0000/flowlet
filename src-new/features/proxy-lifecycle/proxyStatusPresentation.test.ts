import { describe, expect, it } from "vitest";
import { formatDuration, getProxyHint, getProxyPhaseLabel } from "./proxyStatusPresentation";
import type { ProxyRuntimeState } from "../../domains/proxy/types";

describe("proxy status presentation", () => {
  it("formats the legacy runtime duration", () => {
    expect(formatDuration(90_000)).toBe("1分钟");
    expect(formatDuration(3_720_000)).toBe("1小时 2分钟");
    expect(formatDuration(93_720_000)).toBe("1天 2小时 2分钟");
  });

  it("keeps proxy state separate from configuration state", () => {
    expect(getProxyHint("running", "unconfigured", true)).toContain("尚未配置渠道账号");
    expect(getProxyHint("running", "no_models", true)).toContain("开放至少一个模型");
    expect(getProxyHint("running", "ready", true)).toBe("本地代理正在监听请求");
  });

  it("maps all runtime phase labels", () => {
    const phases: ProxyRuntimeState[] = ["starting", "running", "stopped", "failed"];
    expect(phases.map(getProxyPhaseLabel)).toEqual([
      "正在启动",
      "运行中",
      "已停止",
      "启动失败",
    ]);
  });
});
