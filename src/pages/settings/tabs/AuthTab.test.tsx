import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTab } from "./AuthTab";

const api = vi.hoisted(() => ({
  oidc: vi.fn(), github: vi.fn(), mode: vi.fn(), saveMode: vi.fn(), saveOidc: vi.fn(),
  saveGithub: vi.fn(), deleteOidc: vi.fn(), deleteGithub: vi.fn(), checkOidc: vi.fn(),
}));
vi.mock("../../../domains/settings/oidcAuthProvider", () => ({
  getOidcAuthProvider: api.oidc, getAdminLoginMode: api.mode, saveAdminLoginMode: api.saveMode,
  saveOidcAuthProvider: api.saveOidc, deleteOidcAuthProvider: api.deleteOidc, checkOidcAuthProvider: api.checkOidc,
}));
vi.mock("../../../domains/settings/authProviders", () => ({
  getGithubAuthProvider: api.github, saveGithubAuthProvider: api.saveGithub,
  deleteGithubAuthProvider: api.deleteGithub, checkGithubAuthProvider: vi.fn(),
  splitListInput: (s: string) => s.split(/[\n,，、;；]+/).map((x) => x.trim()).filter(Boolean),
}));
vi.mock("@douyinfe/semi-ui-19", () => ({
  Banner: ({ description }: any) => <div>{description}</div>,
  Button: ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Input: ({ value, onChange, "aria-label": ariaLabel }: any) => (
    <input aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  TextArea: ({ value, onChange, "aria-label": ariaLabel }: any) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  Switch: ({ checked, onChange, disabled, "aria-label": ariaLabel }: any) => (
    <input aria-label={ariaLabel} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  ),
  Select: ({ value, onChange, optionList, "aria-label": ariaLabel }: any) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {optionList.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
  Toast: { success: vi.fn(), error: vi.fn() },
}));

let enabled: string[];
const oidcSummary = (overrides: Record<string, unknown> = {}) => ({
  configured: true, deployment_ready: true, source: "stored", issuer: "https://gitlab.example.com",
  discovery_url: "", client_id: "cid", secret_set: true, generation: 3,
  display_name: "GitLab", scopes: "openid", redirect_urls: [], email_claim: "email", name_claim: "name", groups_claim: "groups",
  allowed_subs: ["94"], allowed_emails: [], allowed_groups: ["platform/infra"], allowed_domains: [], admin_subs: ["94"], admin_emails: [],
  allow_any: false, allow_http_issuer: false, insecure_http: false, pkce: "auto", nonce: "required", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  enabled = ["oidc", "github"];
  api.mode.mockImplementation(async () => ({ enabled: [...enabled], oidc_configured: true, github_configured: true, token_login: true }));
  api.saveMode.mockImplementation(async (next: string[]) => { enabled = [...next]; });
  api.oidc.mockImplementation(async () => oidcSummary());
  api.github.mockResolvedValue({
    configured: true, client_id: "gh", secret_set: true, allowed_logins: ["user"], allowed_emails: [],
    admin_logins: [], admin_emails: [], allowed_orgs: [], allow_any: false,
  });
  api.saveOidc.mockResolvedValue({ generation: 4, adopted_endpoints: false });
});

const section = (name: string) => within(screen.getByText(name, { exact: true }).closest("section")!);

describe("登录与访问：GitLab / OIDC 自助配置", () => {
  it("部署字段可编辑；保存带上 generation、issuer 与完整名单", async () => {
    render(<AuthTab />);
    const oidc = section("绑定 GitLab 应用");
    await waitFor(() => expect(oidc.getByDisplayValue("https://gitlab.example.com")).toBeInTheDocument());
    fireEvent.change(oidc.getByDisplayValue("https://gitlab.example.com"), { target: { value: "https://git2.example.com" } });
    fireEvent.change(oidc.getByDisplayValue("cid"), { target: { value: "new-cid" } });
    const roster = section("谁能登录 · 谁能管理");
    expect(roster.getByLabelText("可登录用户")).toBeInTheDocument();
    fireEvent.change(roster.getByLabelText("可登录用户"), { target: { value: "101\nalice@example.com" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => {
      const footer = document.querySelector("[class*='_footerStatus']");
      const shown = footer?.textContent ?? document.body.textContent ?? "";
      if (!api.saveOidc.mock.calls.length) throw new Error(`save not called; footer says: ${shown.slice(0, 200)}`);
    });
    expect(api.saveOidc.mock.calls[0]![0]).toMatchObject({
      issuer: "https://git2.example.com",
      client_id: "new-cid",
      generation: 3,
      allowed_subs: ["101"],
      allowed_emails: ["alice@example.com"],
      allowed_groups: ["platform/infra"],
      admin_subs: ["94"],
    });
    // secret 不回显，也就不会提交
    expect(api.saveOidc.mock.calls[0]![0].client_secret).toBe("");
  });

  it("校验结果逐条展示（通过 / 警告 / 失败）", async () => {
    api.checkOidc.mockResolvedValue({
      ok: false,
      message: "校验未通过，请按下面的条目修正",
      items: [
        { key: "discovery", status: "ok", message: "discovery 可用" },
        { key: "client", status: "error", message: "GitLab 判定 Application ID / Secret 不匹配（invalid_client）" },
        { key: "pkce", status: "warning", message: "IdP 未声明 PKCE S256" },
      ],
    });
    render(<AuthTab />);
    const check = section("连接校验");
    await waitFor(() => expect(check.getByRole("button", { name: "开始校验" })).toBeEnabled());
    fireEvent.click(check.getByRole("button", { name: "开始校验" }));
    await waitFor(() => expect(check.getByText(/invalid_client/u)).toBeInTheDocument());
    expect(check.getByText("IdP 未声明 PKCE S256")).toBeInTheDocument();
  });

  it("未填准入就保存：前端直接拦下，不发请求", async () => {
    api.oidc.mockImplementation(async () => oidcSummary({ allowed_subs: [], allowed_groups: [] }));
    render(<AuthTab />);
    const roster = section("谁能登录 · 谁能管理");
    await waitFor(() => expect(roster.getByLabelText("可登录组")).toBeInTheDocument());
    fireEvent.change(roster.getByLabelText("可登录组"), { target: { value: "" } });
    fireEvent.change(roster.getByLabelText("可登录用户"), { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(screen.getByText(/至少填一个可登录的用户/u)).toBeInTheDocument());
    expect(api.saveOidc).not.toHaveBeenCalled();
  });

  it("改掉 GitLab 开关后保存：开关一并提交，且不复活 GitHub 的旧状态", async () => {
    render(<AuthTab />);
    await waitFor(() => expect(screen.getByLabelText("在登录页启用 GitLab 登录")).toBeChecked());
    // 另一个窗口已经把 GitHub 关掉
    enabled = ["oidc"];
    fireEvent.click(screen.getByLabelText("在登录页启用 GitLab 登录"));
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(api.saveMode).toHaveBeenCalled());
    expect(api.saveMode.mock.calls[0]![0]).toEqual([]);
  });

  it("来源是环境变量时明确提示，保存后由界面接管", async () => {
    api.oidc.mockImplementation(async () => oidcSummary({ source: "env", generation: 0 }));
    render(<AuthTab />);
    await waitFor(() => expect(screen.getByText("启用中（沿用部署环境变量）")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "保存" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(api.saveOidc).toHaveBeenCalled());
    // 未接管时不带 generation，避免误触乐观锁
    expect(api.saveOidc.mock.calls[0]![0].generation).toBeUndefined();
  });

  it("移除：先关开关再删配置，其它提供方状态原样保留", async () => {
    render(<AuthTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "移除配置" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "移除配置" }));
    await waitFor(() => expect(api.deleteOidc).toHaveBeenCalledTimes(1));
    expect(api.saveMode).toHaveBeenCalledWith(["github"]);
  });
});

describe("登录与访问：GitHub OAuth", () => {
  it("保存 GitHub 开关时以服务端最新开关为准", async () => {
    render(<AuthTab />);
    const github = section("GitHub 登录");
    await waitFor(() => expect(github.getByRole("button", { name: "保存" })).toBeEnabled());
    enabled = ["github"];
    fireEvent.click(github.getByLabelText("在登录页启用 GitHub 登录"));
    fireEvent.click(github.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(String(api.saveMode.mock.calls[api.saveMode.mock.calls.length - 1]?.[0])).toBe(""));
  });
});
