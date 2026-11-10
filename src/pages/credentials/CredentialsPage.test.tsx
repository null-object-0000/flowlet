import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPreferencesProvider } from "../../app/preferences/AppPreferences";
import { CredentialsPage } from "./CredentialsPage";

const commands = vi.hoisted(() => ({
  listProviders: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  listCliAuthTokens: vi.fn(),
  revokeCliAuthToken: vi.fn(),
}));

const webHost = vi.hoisted(() => ({ value: true }));

vi.mock("../../domains/credentials/commands", () => ({ credentialCommands: commands }));
vi.mock("../../platform/web/mode", () => ({
  get isWebHost() {
    return webHost.value;
  },
}));

const providers = [
  {
    id: "gitlab",
    label: "GitLab",
    baseUrlHint: "https://gitlab.example.com",
    tokenLabel: "Personal Access Token（需要 api scope）",
    available: true,
    defaultEnvPrefix: "GITLAB",
  },
  {
    id: "dockhand",
    label: "Dockhand",
    baseUrlHint: "http://dockhand.example.com:3000",
    tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
    available: true,
    defaultEnvPrefix: "DOCKHAND",
  },
];

const credentials = [
  {
    id: "cred-na",
    name: "公司-北美-线上",
    provider: "dockhand",
    baseUrl: "http://dockhand-na.example.com:3000",
    kind: "cli_token",
    note: null,
    enabled: true,
    envPrefix: "DOCKHAND_NA",
    secretHint: "••••1a2b",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    lastVerifiedAt: null,
    lastError: null,
  },
  {
    id: "cred-default",
    name: "公司 GitLab",
    provider: "gitlab",
    baseUrl: "https://gitlab.example.com",
    kind: "cli_token",
    note: null,
    enabled: true,
    envPrefix: "GITLAB",
    secretHint: "••••3c4d",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    lastVerifiedAt: null,
    lastError: null,
  },
];

const manifest = {
  version: "0.2.0",
  generatedAt: "2026-11-10T03:00:00Z",
  artifacts: [
    { path: "flowlet-cli.tar.gz", bytes: 421036, sha256: "a".repeat(64) },
    { path: "flowlet-skills.tar.gz", bytes: 2480, sha256: "b".repeat(64) },
    { path: "install-flowlet.sh", bytes: 7592, sha256: "c".repeat(64) },
  ],
};

// Semi Typography 的 ellipsis 会在挂载后测量 Range；jsdom 没有布局，补一个零尺寸实现。
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  const emptyRect = () =>
    ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = emptyRect;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppPreferencesProvider>
        <CredentialsPage />
      </AppPreferencesProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  webHost.value = true;
  commands.listProviders.mockResolvedValue(providers);
  commands.list.mockResolvedValue(credentials);
  commands.listCliAuthTokens.mockResolvedValue([]);
  commands.revokeCliAuthToken.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => manifest,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CredentialsPage env prefix", () => {
  it("shows the resolved env prefix per credential", async () => {
    renderPage();
    expect(await screen.findByText("DOCKHAND_NA_*")).toBeInTheDocument();
    expect(screen.getByText("GITLAB_*")).toBeInTheDocument();
  });

  it("prefills and previews the env prefix when editing", async () => {
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/ })[0]!);
    const input = (await screen.findByPlaceholderText(/e\.g\. DOCKHAND_NA/)) as HTMLInputElement;
    expect(input.value).toBe("DOCKHAND_NA");
    expect(screen.getByText(/DOCKHAND_NA_URL \/ DOCKHAND_NA_TOKEN/)).toBeInTheDocument();
  });

  it("uppercases the preview prefix while typing", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));
    const input = (await screen.findByPlaceholderText(/e\.g\. GITLAB_NA/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "self" } });
    await waitFor(() =>
      expect(screen.getByText(/SELF_URL \/ SELF_TOKEN/)).toBeInTheDocument(),
    );
  });
});

describe("CredentialsPage local access guide", () => {
  it("opens the guide with install command, skills link and env preview", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local access/ }));

    expect(await screen.findByText(/install-flowlet\.sh \| sh -s -- --base=/)).toBeInTheDocument();
    expect(screen.getByText("flowlet-skills.tar.gz", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/DOCKHAND_NA_URL/)).toBeInTheDocument();
    expect(await screen.findByText("0.2.0")).toBeInTheDocument();
    expect(screen.getByText(/sha256 aaaaaaaaaaaaaaaa/)).toBeInTheDocument();
  });

  it("shows the two-step login + pull commands without any admin credential", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local access/ }));

    // 页面 Banner 与本机接入抽屉都会展示 login 命令；抽屉里的 pull 命令是新增的第二步。
    expect((await screen.findAllByText(/flowlet login --server=http:\/\/localhost/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/flowlet pull --server=http:\/\/localhost/)).toBeInTheDocument();
    expect(screen.queryByText(/--token=/)).not.toBeInTheDocument();
  });

  it("lists authorized CLIs and revokes one after confirmation", async () => {
    commands.listCliAuthTokens.mockResolvedValue([
      {
        id: "cli-1",
        name: "agent-box",
        scope: "credentials:read",
        createdAt: "2026-11-01T00:00:00Z",
        expiresAt: "2026-12-01T00:00:00Z",
        lastUsedAt: null,
      },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local access/ }));

    expect(await screen.findByText("agent-box")).toBeInTheDocument();
    expect(screen.getByText(/Never used/)).toBeInTheDocument();

    // 行内撤销 → 确认弹窗（Semi Modal）→ 调用命令并失效查询。
    // SideSheet 也是 role=dialog，因此用弹窗标题定位后点确认按钮（Semi 的确认键固定 aria-label）。
    fireEvent.click(screen.getByRole("button", { name: /Revoke/ }));
    await screen.findByText("Revoke CLI authorization");
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(commands.revokeCliAuthToken).toHaveBeenCalledWith("cli-1"));
    await waitFor(() => expect(commands.listCliAuthTokens).toHaveBeenCalledTimes(2));
  });

  it("degrades gracefully when the host has no CLI authorization commands", async () => {
    commands.listCliAuthTokens.mockRejectedValue(new Error("unknown command"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local access/ }));

    expect(await screen.findByText(/does not support listing CLI authorizations/)).toBeInTheDocument();
    // 其它段落仍然可用：安装命令与登录命令没有连带报错。
    expect(await screen.findByText(/install-flowlet\.sh \| sh -s -- --base=/)).toBeInTheDocument();
    expect(screen.getAllByText(/flowlet login --server=http:\/\/localhost/).length).toBeGreaterThan(0);
    expect(screen.queryByText("unknown command")).not.toBeInTheDocument();
  });

  it("hides the local access entry outside the web host", async () => {
    webHost.value = false;
    renderPage();
    await screen.findByText("公司-北美-线上");
    expect(screen.queryByRole("button", { name: /Local access/ })).not.toBeInTheDocument();
  });
});