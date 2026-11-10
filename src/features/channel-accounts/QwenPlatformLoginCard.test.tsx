import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QwenPlatformStatus } from "../../domains/account/qwenPlatform";
import {
  QwenPlatformFallbackHint,
  QwenPlatformLoginCard,
  QwenPlatformSyncModeTag,
  type QwenPlatformTranslate,
} from "./QwenPlatformLoginCard";
import type { UseQwenPlatformLoginResult } from "./useQwenPlatformLogin";

/** 测试用的 `t`：把 params 填回模板，便于断言最终文案。 */
const t: QwenPlatformTranslate = (source, variables) =>
  variables
    ? source.replace(/\{(\w+)\}/g, (match, key: string) => String(variables[key] ?? match))
    : source;

function loggedOutStatus(accountId = "acc-1"): QwenPlatformStatus {
  return { accountId, loggedIn: false, aliyunId: null, email: null, expiresAt: null };
}

function loggedInStatus(expiresAt: string | null = "2026-11-12T05:54:20Z"): QwenPlatformStatus {
  return {
    accountId: "acc-1",
    loggedIn: true,
    aliyunId: "nich*****@outlook.com",
    email: null,
    expiresAt,
  };
}

type PlatformOverrides = Partial<UseQwenPlatformLoginResult>;

/** 构造 hook 返回值；测试只关心渲染分支，动作全部用 spy。 */
function platformOf(overrides: PlatformOverrides = {}): UseQwenPlatformLoginResult {
  return {
    status: loggedOutStatus(),
    statusLoading: false,
    phase: "idle",
    isPolling: false,
    isSyncing: false,
    waitingForBrowser: false,
    isLoggedIn: false,
    loginStart: null,
    lastSync: null,
    error: null,
    errorScope: null,
    startLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => null),
    refreshStatus: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderCard(overrides: PlatformOverrides = {}, enabled = true) {
  const platform = platformOf(overrides);
  render(
    <QwenPlatformLoginCard
      platform={platform}
      enabled={enabled}
      language="zh-CN"
      t={t}
      loggedOutHint="未登录说明"
      loggedInHint="已登录说明"
    />,
  );
  return platform;
}

describe("QwenPlatformLoginCard", () => {
  it("未登录时展示登录 CTA，点击后发起 device flow", async () => {
    const platform = renderCard();
    expect(screen.getByText("未登录")).toBeInTheDocument();
    expect(screen.getByText("未登录说明")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "登录千问平台" }));
    expect(platform.startLogin).toHaveBeenCalledTimes(1);
  });

  it("新建未保存账号（enabled=false）禁用登录并提示先保存", () => {
    renderCard({}, false);
    expect(screen.getByText("保存账号后可登录千问平台")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录千问平台" })).toBeDisabled();
  });

  it("等待浏览器授权时展示取消入口", async () => {
    const platform = renderCard({ phase: "waiting", isPolling: true, waitingForBrowser: true });
    expect(screen.getByText("等待浏览器授权…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(platform.cancelLogin).toHaveBeenCalledTimes(1);
  });

  it("已登录时展示账号、有效期、重新登录与退出登录", async () => {
    const platform = renderCard({ status: loggedInStatus(), isLoggedIn: true });
    expect(screen.getByText("已登录")).toBeInTheDocument();
    expect(screen.getByText("已登录 nich*****@outlook.com")).toBeInTheDocument();
    expect(screen.getByText(/登录有效至 /)).toBeInTheDocument();
    expect(screen.getByText("已登录说明")).toBeInTheDocument();
    const relogin = screen.getByText("重新登录").closest("button");
    expect(relogin).not.toBeNull();
    await userEvent.click(relogin!);
    expect(platform.startLogin).toHaveBeenCalledTimes(1);
    const logout = screen.getByText("退出登录").closest("button");
    expect(logout).not.toBeNull();
    await userEvent.click(logout!);
    expect(platform.logout).toHaveBeenCalledTimes(1);
  });

  it("expiresAt 为数字时间戳时也能格式化，不崩溃", () => {
    const epochSeconds = String(Math.floor(Date.parse("2026-11-12T05:54:20Z") / 1000));
    renderCard({ status: loggedInStatus(epochSeconds), isLoggedIn: true });
    expect(screen.getByText(/登录有效至 /)).toBeInTheDocument();
    expect(screen.queryByText(/^\d{10}$/)).not.toBeInTheDocument();
  });

  it("登录阶段错误直接展示，同步阶段错误交给同步区块", () => {
    renderCard({ error: "登录失败：连接超时", errorScope: "login" });
    expect(screen.getByText("登录失败：连接超时")).toBeInTheDocument();
  });

  it("亚状态：登录完成的自动同步期间仍按已登录渲染", () => {
    renderCard({ status: loggedInStatus(), isLoggedIn: false, isSyncing: true, phase: "syncing" });
    expect(screen.getByText("已登录 nich*****@outlook.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录千问平台" })).not.toBeInTheDocument();
  });
});

describe("QwenPlatformSyncModeTag", () => {
  it("未登录展示 WebView 抓取，已登录展示 HTTP 同步", () => {
    const { rerender } = render(<QwenPlatformSyncModeTag platform={platformOf()} t={t} />);
    expect(screen.getByText("WebView 抓取")).toBeInTheDocument();
    rerender(
      <QwenPlatformSyncModeTag
        platform={platformOf({ status: loggedInStatus(), isLoggedIn: true })}
        t={t}
      />,
    );
    expect(screen.getByText("HTTP 同步")).toBeInTheDocument();
  });
});

describe("QwenPlatformFallbackHint", () => {
  it("已登录不渲染", () => {
    const { container } = render(
      <QwenPlatformFallbackHint
        platform={platformOf({ status: loggedInStatus(), isLoggedIn: true })}
        t={t}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("桌面端与 Web Host 的兜底说明不同", () => {
    const { rerender } = render(
      <QwenPlatformFallbackHint platform={platformOf()} desktopCapabilities t={t} />,
    );
    expect(screen.getByText("未登录千问平台，当前使用 WebView 控制台抓取；登录后可改为 HTTP 同步。"))
      .toBeInTheDocument();
    rerender(<QwenPlatformFallbackHint platform={platformOf()} desktopCapabilities={false} t={t} />);
    expect(screen.getByText("未登录千问平台，请先登录以获得 HTTP 同步。")).toBeInTheDocument();
  });
});