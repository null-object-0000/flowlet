import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersPanel } from "./UsersPanel";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../platform/web/client", () => ({ invokeWebCommand: invoke }));
describe("managed users", () => {
  it("searches persisted users by email", async () => {
    invoke.mockResolvedValue([{ id:"u1",email:"person@example.com",name:"Person",role:"viewer",enabled:true,identities:["oidc:1"],lastLoginAt:"2026-11-17T00:00:00Z" }]);
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><UsersPanel /></QueryClientProvider>);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索用户"), {target:{value:"unmatched"}});
    expect(screen.queryByText("person@example.com")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索用户"), {target:{value:"PERSON@EXAMPLE"}});
    expect(screen.getByText("person@example.com")).toBeInTheDocument();
  });
});
