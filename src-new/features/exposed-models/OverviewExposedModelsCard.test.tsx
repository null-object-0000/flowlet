import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { OverviewExposedModelsCard } from "./OverviewExposedModelsCard";

vi.mock("lottie-web", () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) } }));

const accounts = [
  { id: "a1", channel_id: "deepseek", enabled: true, api_key: "sk-1", credential_status: "healthy" },
  { id: "a2", channel_id: "deepseek", enabled: false, api_key: "sk-2", credential_status: "healthy" },
] as ChannelAccount[];

const routes = [
  { id: "r1", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", enabled: true },
  { id: "r2", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a2", client_protocol: "openai", enabled: true },
  { id: "r3", virtual_model_id: "deepseek-v4-flash", upstream_model: "deepseek-v4-flash", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", enabled: false },
] as RouteCandidate[];

const channels = [{ id: "deepseek", name: "DeepSeek" }] as ChannelPreset[];

describe("OverviewExposedModelsCard", () => {
  it("groups routes by public model and saves all grouped switches together", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    render(
      <OverviewExposedModelsCard
        routes={routes}
        accounts={accounts}
        channels={channels}
        onManage={vi.fn()}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText("共 1 个模型")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-pro")).toBeInTheDocument();
    expect(screen.getAllByText("1 个可用账号")).toHaveLength(2);
    expect(screen.getByText("deepseek-v4-flash")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "deepseek-v4-pro 对外开放" }));
    expect(onToggle).toHaveBeenCalledWith(["r1", "r2"], "deepseek-v4-pro", false);
  });
});
