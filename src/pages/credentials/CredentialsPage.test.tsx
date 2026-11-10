import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  reveal: vi.fn(),
  suggestEnvPrefixSegment: vi.fn(),
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
    usernameLabel: null,
    available: true,
    defaultEnvPrefix: "DOCKHAND",
  },
  {
    id: "jenkins",
    label: "Jenkins",
    baseUrlHint: "https://jenkins.example.com",
    tokenLabel: "API Token（Jenkins 用户设置 → API Token）",
    usernameLabel: "用户名",
    available: true,
    defaultEnvPrefix: "JENKINS",
  },
  {
    id: "beszel",
    label: "Beszel",
    baseUrlHint: "http://beszel.example.com:8090",
    tokenLabel: "登录密码（Beszel 用户密码）",
    usernameLabel: "邮箱",
    available: true,
    defaultEnvPrefix: "BESZEL",
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
    id: "cred-jenkins",
    name: "公司 Jenkins",
    provider: "jenkins",
    baseUrl: "https://jenkins.example.com",
    username: "ci-bot",
    kind: "cli_token",
    note: null,
    enabled: true,
    envPrefix: "JENKINS",
    secretHint: "••••5e6f",
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
  {
    id: "cred-beszel",
    name: "公司 Beszel",
    provider: "beszel",
    baseUrl: "http://beszel.example.com:8090",
    // Beszel 没有长期 API Token：username 存登录邮箱，token 存密码。
    username: "ops@example.com",
    kind: "cli_token",
    note: null,
    enabled: true,
    envPrefix: "BESZEL",
    secretHint: "••••7g8h",
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
    // Jenkins 用 Basic 认证：列表额外展示用户名，前缀走 JENKINS 默认值。
    expect(screen.getByText("JENKINS_*")).toBeInTheDocument();
    expect(screen.getByText("@ci-bot")).toBeInTheDocument();
  });

  it("prefills and previews the env prefix when editing", async () => {
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/ })[0]!);
    const input = (await screen.findByPlaceholderText(/Leave blank for the default DOCKHAND/)) as HTMLInputElement;
    expect(input.value).toBe("DOCKHAND_NA");
    expect(screen.getByText(/DOCKHAND_NA_URL \/ DOCKHAND_NA_TOKEN/)).toBeInTheDocument();
  });

  it("uppercases the preview prefix while typing", async () => {
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));
    const input = (await screen.findByPlaceholderText(/Leave blank for the default GITLAB/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "self" } });
    await waitFor(() =>
      expect(screen.getByText(/SELF_URL \/ SELF_TOKEN/)).toBeInTheDocument(),
    );
  });
});

describe("CredentialsPage env prefix auto-generation", () => {
  it("prefills a non-conflicting prefix from name/note until the user edits it", async () => {
    renderPage();
    // 等待已有凭据列表加载完成：自动生成需要避开它们已占用的前缀。
    await screen.findByText("公司-北美-线上");
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));
    const prefixInput = (await screen.findByPlaceholderText(
      /Leave blank for the default GITLAB/,
    )) as HTMLInputElement;
    // 已有凭据占用了 GITLAB，默认建议自动避让为 GITLAB_2
    expect(prefixInput.value).toBe("GITLAB_2");

    const nameInput = (await screen.findByPlaceholderText(/For example: Company/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "自建 sz 实例" } });
    await waitFor(() => expect(prefixInput.value).toBe("GITLAB_SZ"));

    // 手动改过之后不再被名称覆盖
    fireEvent.change(prefixInput, { target: { value: "MY_OWN" } });
    fireEvent.change(nameInput, { target: { value: "另一个 na 实例" } });
    await waitFor(() => expect(prefixInput.value).toBe("MY_OWN"));

    // 「自动生成」重新按名称/备注生成
    fireEvent.click(screen.getByRole("button", { name: /Auto-generate/ }));
    await waitFor(() => expect(prefixInput.value).toBe("GITLAB_NA"));
  });
});

describe("CredentialsPage AI env prefix", () => {
  it("uses the model suggestion when clicked, and stays disabled until a name is filled", async () => {
    commands.suggestEnvPrefixSegment.mockResolvedValue({
      segment: "NA_PROD",
      model: "deepseek-v4.1-flash",
    });
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));

    const aiButton = screen.getByRole("button", { name: /AI generate/ });
    expect(aiButton).toBeDisabled();

    const nameInput = (await screen.findByPlaceholderText(/For example: Company/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "公司北美 Dockhand 正式" } });
    await waitFor(() => expect(aiButton).not.toBeDisabled());

    fireEvent.click(aiButton);
    await waitFor(() => expect(commands.suggestEnvPrefixSegment).toHaveBeenCalledTimes(1));
    const prefixInput = (await screen.findByPlaceholderText(
      /Leave blank for the default GITLAB/,
    )) as HTMLInputElement;
    await waitFor(() => expect(prefixInput.value).toBe("GITLAB_NA_PROD"));
    // 请求里带上名称、备注与已占用的前缀，且不泄露 token
    const payload = commands.suggestEnvPrefixSegment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.name).toBe("公司北美 Dockhand 正式");
    expect(payload.providerDefault).toBe("GITLAB");
    expect(Array.isArray(payload.used)).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/token/i);
  });

  it("falls back to the rule-based suggestion when AI generation fails", async () => {
    commands.suggestEnvPrefixSegment.mockRejectedValue(new Error("没有可用的开放模型"));
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));
    const nameInput = (await screen.findByPlaceholderText(/For example: Company/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "campus sz box" } });
    fireEvent.click(await screen.findByRole("button", { name: /AI generate/ }));
    await waitFor(() => expect(commands.suggestEnvPrefixSegment).toHaveBeenCalled());
    const prefixInput = (await screen.findByPlaceholderText(
      /Leave blank for the default GITLAB/,
    )) as HTMLInputElement;
    await waitFor(() => expect(prefixInput.value).toBe("GITLAB_CAMPUS_SZ_BOX"));
  });
});

describe("CredentialsPage raw token reveal", () => {
  it("reveals the saved token on demand while the table keeps only the mask", async () => {
    commands.reveal.mockResolvedValue({
      id: "cred-na",
      name: "公司-北美-线上",
      provider: "dockhand",
      envPrefix: "DOCKHAND_NA",
      token: "dockhand-raw-token-abc123",
    });
    renderPage();
    await screen.findByText("公司-北美-线上");
    // 默认不出现明文，只出现掩码
    expect(screen.queryByText("dockhand-raw-token-abc123")).not.toBeInTheDocument();
    expect(screen.getByText("••••1a2b")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Reveal raw token/ })[0]!);
    expect(await screen.findByText("dockhand-raw-token-abc123")).toBeInTheDocument();
    expect(screen.getByText(/plaintext token of a saved credential/)).toBeInTheDocument();
    expect(commands.reveal).toHaveBeenCalledWith("cred-na");
  });

  it("keeps the dialog closed when the host rejects the reveal", async () => {
    commands.reveal.mockRejectedValue(new Error("unsupported_in_web"));
    renderPage();
    await screen.findByText("公司-北美-线上");
    fireEvent.click(screen.getAllByRole("button", { name: /Reveal raw token/ })[0]!);
    await waitFor(() => expect(commands.reveal).toHaveBeenCalled());
    expect(screen.queryByText(/plaintext token of a saved credential/)).not.toBeInTheDocument();
  });
});

describe("CredentialsPage local access guide", () => {
  it("opens the guide with install command, skills link and env preview", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local access/ }));

    expect(await screen.findByText(/install-flowlet\.sh \| sh -s -- --base=/)).toBeInTheDocument();
    expect(screen.getByText("flowlet-skills.tar.gz", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/DOCKHAND_NA_URL/)).toBeInTheDocument();
    // Beszel 的环境变量名同步展示 URL / EMAIL / PASSWORD。
    expect(screen.getByText(/BESZEL_EMAIL/)).toBeInTheDocument();
    expect(screen.getByText(/BESZEL_PASSWORD/)).toBeInTheDocument();
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

describe("CredentialsPage jenkins provider", () => {
  it("prefills the username and previews three env keys when editing", async () => {
    renderPage();
    const name = await screen.findByText("公司 Jenkins");
    const row = name.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Edit/ }));

    const username = (await screen.findByPlaceholderText(/jenkins-user/)) as HTMLInputElement;
    expect(username.value).toBe("ci-bot");
    expect(screen.getByText(/JENKINS_URL \/ JENKINS_USER \/ JENKINS_TOKEN/)).toBeInTheDocument();
    expect(screen.getAllByText((content) => content.includes("me/api/json")).length).toBeGreaterThan(0);
  });

  it("submits the username together with the credential", async () => {
    commands.save.mockResolvedValue({ ...credentials[2] });
    renderPage();
    const name = await screen.findByText("公司 Jenkins");
    const row = name.closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Edit/ }));

    const username = (await screen.findByPlaceholderText(/jenkins-user/)) as HTMLInputElement;
    fireEvent.change(username, { target: { value: "deploy-bot" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and verify/ }));

    await waitFor(() =>
      expect(commands.save).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "jenkins", username: "deploy-bot" }),
      ),
    );
  });

  it("disables save until a username is entered for jenkins", async () => {
    renderPage();
    const name = await screen.findByText("公司 Jenkins");
    const row = name.closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Edit/ }));

    const username = (await screen.findByPlaceholderText(/jenkins-user/)) as HTMLInputElement;
    fireEvent.change(username, { target: { value: "" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Save and verify/ })).toBeDisabled(),
    );
  });
});

describe("CredentialsPage beszel provider", () => {
  const sheet = () => document.querySelector(".semi-sidesheet") as HTMLElement;

  it("shows the BESZEL prefix and the login email in the table", async () => {
    renderPage();
    expect(await screen.findByText("BESZEL_*")).toBeInTheDocument();
    expect(screen.getByText("Beszel")).toBeInTheDocument();
    // beszel 的 username 存登录邮箱，表格与 jenkins 一样展示 @email。
    expect(screen.getByText("@ops@example.com")).toBeInTheDocument();
  });

  it("prefills the email and previews URL / EMAIL / PASSWORD when editing", async () => {
    renderPage();
    const name = await screen.findByText("公司 Beszel");
    const row = name.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Edit/ }));

    // 用户名输入框由 usernameLabel 驱动：beszel 显示「邮箱」并回填登录邮箱。
    const username = (await screen.findByPlaceholderText("e.g. you@example.com")) as HTMLInputElement;
    expect(username.value).toBe("ops@example.com");
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(
      screen.getByText(/BESZEL_URL \/ BESZEL_EMAIL \/ BESZEL_PASSWORD/),
    ).toBeInTheDocument();
    // 校验端点提示与「留空保留密码」placeholder。
    expect(screen.getAllByText((content) => content.includes("auth-with-password")).length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText(/Leave blank to keep the current password/)).toBeInTheDocument();
  });

  it("requires both email and password when creating a beszel credential", async () => {
    commands.save.mockResolvedValue({ ...credentials[3] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Add credential/ }));

    // 切换服务类型到 Beszel（Semi Select 的选项渲染在 portal 里）。
    fireEvent.click(within(sheet()).getByText("GitLab"));
    fireEvent.click(await screen.findByRole("option", { name: /Beszel/ }));
    await waitFor(() => expect(within(sheet()).getAllByText("Beszel").length).toBeGreaterThan(0));

    const email = (await screen.findByPlaceholderText("e.g. you@example.com")) as HTMLInputElement;
    const password = screen.getByPlaceholderText(/Paste the Beszel login password/) as HTMLInputElement;
    const baseUrl = screen.getByPlaceholderText("http://beszel.example.com:8090") as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: /Save and verify/ });

    // 新建 beszel：邮箱 + 密码都是必填，自动前缀避让已有 BESZEL。
    expect(saveButton).toBeDisabled();
    expect(
      screen.getByText(/BESZEL_2_URL \/ BESZEL_2_EMAIL \/ BESZEL_2_PASSWORD/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/For example: Company Beszel/), {
      target: { value: "公司 Beszel 监控" },
    });
    fireEvent.change(baseUrl, { target: { value: "http://beszel.example.com:8090" } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(email, { target: { value: "ops@example.com" } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(password, { target: { value: "beszel-password" } });
    await waitFor(() => expect(saveButton).not.toBeDisabled());

    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(commands.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "beszel",
          username: "ops@example.com",
          token: "beszel-password",
        }),
      ),
    );
  });

  it("allows keeping the current email when editing a beszel credential", async () => {
    commands.save.mockResolvedValue({ ...credentials[3] });
    renderPage();
    const name = await screen.findByText("公司 Beszel");
    const row = name.closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Edit/ }));

    const username = (await screen.findByPlaceholderText("e.g. you@example.com")) as HTMLInputElement;
    fireEvent.change(username, { target: { value: "  " } });
    // 编辑时留空表示保持原邮箱：保存按钮仍可用，payload 不带 username。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Save and verify/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save and verify/ }));
    await waitFor(() => expect(commands.save).toHaveBeenCalled());
    const payload = commands.save.mock.calls[0]![0] as { username?: string };
    expect(payload.username).toBeUndefined();
  });
});
