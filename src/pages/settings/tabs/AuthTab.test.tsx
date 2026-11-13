import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthTab } from "./AuthTab";

const api = vi.hoisted(() => ({
  oidc: vi.fn(), github: vi.fn(), mode: vi.fn(), saveMode: vi.fn(), saveOidc: vi.fn(),
  saveGithub: vi.fn(), deleteOidc: vi.fn(), deleteGithub: vi.fn(),
}));
vi.mock("../../../domains/settings/oidcAuthProvider", () => ({
  getOidcAuthProvider: api.oidc, getAdminLoginMode: api.mode, saveAdminLoginMode: api.saveMode,
  saveOidcAuthProvider: api.saveOidc, deleteOidcAuthProvider: api.deleteOidc, checkOidcAuthProvider: vi.fn(),
}));
vi.mock("../../../domains/settings/authProviders", () => ({
  getGithubAuthProvider: api.github, saveGithubAuthProvider: api.saveGithub,
  deleteGithubAuthProvider: api.deleteGithub, checkGithubAuthProvider: vi.fn(),
  splitListInput: (s: string) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean),
}));
vi.mock("@douyinfe/semi-ui-19", () => ({
  Banner: ({ description }: any) => <div>{description}</div>,
  Button: ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Input: ({ value, onChange }: any) => <input value={value} onChange={e => onChange(e.target.value)} />,
  TextArea: ({ value, onChange }: any) => <textarea value={value} onChange={e => onChange(e.target.value)} />,
  Switch: ({ checked, onChange, disabled }: any) => <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
  Toast: { success: vi.fn(), error: vi.fn() },
}));

let enabled: string[];
const section = (name: string) => within(screen.getByText(name, { exact: true }).closest("section")!);
beforeEach(() => {
  vi.clearAllMocks();
  enabled = ["oidc", "github"];
  api.mode.mockImplementation(async () => ({ enabled: [...enabled], oidc_configured: true, github_configured: true, token_login: true }));
  api.saveMode.mockImplementation(async (next: string[]) => { enabled = [...next]; });
  api.oidc.mockResolvedValue({ configured: true, deployment_ready: true, source: "env", issuer: "https://idp.example", client_id: "cid", secret_set: true,
    display_name: "GitLab", scopes: "openid", allowed_subs: ["94"], allowed_emails: [], allowed_groups: [], allowed_domains: [], admin_subs: ["94"], admin_emails: [], allow_any: false });
  api.github.mockResolvedValue({ configured: true, client_id: "gh", secret_set: true, allowed_logins: ["user"], allowed_emails: [], admin_logins: [], admin_emails: [], allowed_orgs: [], allow_any: false });
});

describe("登录与访问设置", () => {
  it("部署字段只读，准入保存不提交隐藏的 secret / 回调 / PKCE", async () => {
    render(<AuthTab />);
    const oidc = section("GitLab / OIDC 登录");
    await waitFor(() => expect(oidc.getByRole("button", { name: "保存" })).toBeEnabled());
    expect(oidc.getByText("https://idp.example")).toBeInTheDocument();
    expect(oidc.queryByDisplayValue("cid")).not.toBeInTheDocument();
    fireEvent.change(oidc.getAllByDisplayValue("94")[0]!, { target: { value: "101\nalice@example.com" } });
    fireEvent.click(oidc.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveOidc).toHaveBeenCalled());
    expect(api.saveOidc.mock.calls[0]![0]).toEqual({
      display_name: "GitLab", scopes: "openid", allowed_subs: ["101"], allowed_emails: ["alice@example.com"],
      allowed_groups: [], allowed_domains: [], admin_subs: ["94"], admin_emails: [], allow_any: false,
    });
  });

  it("连续保存两个提供方时沿用最新开关，不复活刚关闭的入口", async () => {
    render(<AuthTab />);
    const github = section("GitHub 登录");
    const oidc = section("GitLab / OIDC 登录");
    await waitFor(() => expect(github.getByRole("button", { name: "保存" })).toBeEnabled());
    fireEvent.click(github.getAllByRole("checkbox")[0]!);
    fireEvent.click(github.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(enabled).toEqual(["oidc"]));
    await waitFor(() => expect(github.getByRole("button", { name: "保存" })).toBeEnabled());
    fireEvent.click(oidc.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveOidc).toHaveBeenCalled());
    await waitFor(() => expect(api.saveMode).toHaveBeenCalledTimes(2));
    expect(enabled).toEqual(["oidc"]);
  });

  it("移除 OIDC 覆盖只恢复部署默认，不尝试关闭最后一个入口", async () => {
    api.oidc.mockResolvedValue({ ...(await api.oidc()), source: "stored" });
    render(<AuthTab />);
    const oidc = section("GitLab / OIDC 登录");
    await waitFor(() => expect(oidc.getByRole("button", { name: "移除界面配置" })).toBeEnabled());
    fireEvent.click(oidc.getByRole("button", { name: "移除界面配置" }));
    await waitFor(() => expect(api.deleteOidc).toHaveBeenCalledTimes(1));
    expect(api.saveMode).not.toHaveBeenCalled();
  });
});
