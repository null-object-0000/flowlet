import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersonalAccessPanel } from "./PersonalAccessPanel";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../platform/web/client", () => ({ invokeWebCommand: invoke }));
function mount(identity: {userId:string;role:string}|null) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><PersonalAccessPanel identity={identity}/></QueryClientProvider>);
  return client;
}
describe("personal access",()=>{
  beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(command=>Promise.resolve(command==="create_personal_token"?{token:"fake-token-shown-once"}:[]));});
  it("requires a personal identity rather than creating a fake static administrator",()=>{
    mount(null);
    expect(screen.getByText(/静态管理凭据属于实例管理员/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("shows a new token once without caching its plaintext in query data",async()=>{
    const client=mount({userId:"user-one",role:"admin"});
    fireEvent.change(screen.getByLabelText("凭据名称"),{target:{value:"巡检"}});
    fireEvent.click(screen.getByRole("button",{name:"创建凭据"}));
    expect(await screen.findByText("fake-token-shown-once")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("create_personal_token",{name:"巡检",scope:"observe",days:30});
    expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain("fake-token-shown-once");
    fireEvent.click(screen.getByRole("button",{name:"关闭并清除"}));
    expect(screen.queryByText("fake-token-shown-once")).not.toBeInTheDocument();
  });
});
