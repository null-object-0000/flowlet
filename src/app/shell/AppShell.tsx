import { DesktopAppFrameView } from "@flowlet/product-ui";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { AgentDataAutoSync } from "../../features/background-tasks/AgentDataAutoSync";
import { CodexAccountAutoSync } from "../../features/background-tasks/CodexAccountAutoSync";
import { ChannelResourceAutoSync } from "../../features/background-tasks/ChannelResourceAutoSync";

export function AppShell() {
  return (
    <>
      <WindowControls />
      <AgentDataAutoSync />
      <CodexAccountAutoSync />
      <ChannelResourceAutoSync />
      <DesktopAppFrameView sidebar={<Sidebar />}><Outlet /></DesktopAppFrameView>
    </>
  );
}
