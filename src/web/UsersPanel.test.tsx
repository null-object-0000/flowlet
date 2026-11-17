import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccessPolicyPanel } from "./AccessPolicyPanel";
import { UsersPanel } from "./UsersPanel";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../platform/web/client", () => ({ invokeWebCommand: invoke }));
describe("managed users", () => {
  it("searches persisted users by email", async () => {
    invoke.mockImplementation(async (command: string) => command === "get_access_policy" ? { generation:1,mode:"existing",emails:[],domains:[],legacyRules:[] } : [{ id:"u1",email:"person@example.com",name:"Person",role:"viewer",enabled:true,identities:["oidc:1"],lastLoginAt:"2026-11-17T00:00:00Z" }]);
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><UsersPanel /></QueryClientProvider>);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索用户"), {target:{value:"unmatched"}});
    expect(screen.queryByText("person@example.com")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索用户"), {target:{value:"PERSON@EXAMPLE"}});
    expect(screen.getByText("person@example.com")).toBeInTheDocument();
  });
  it("saves verified-email admission centrally without provider configuration", async () => {
    invoke.mockClear();
    invoke.mockImplementation(async (command: string) => command === "get_access_policy" ? {generation:4,mode:"rules",emails:["alice@example.com"],domains:[],legacyRules:[]} : null);
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><AccessPolicyPanel /></QueryClientProvider>);
    expect(await screen.findByDisplayValue("alice@example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("允许的邮箱域"),{target:{value:"example.com"}});
    fireEvent.click(screen.getByRole("button",{name:"保存访问策略"}));
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith("set_access_policy",{generation:4,mode:"rules",emails:["alice@example.com"],domains:["example.com"],clearLegacy:false}));
    expect(invoke.mock.calls.some(([command])=>String(command).includes("auth_provider"))).toBe(false);
  });

});
