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
  { id: "r1", virtual_model_id: "flowlet-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", enabled: true },
  { id: "r2", virtual_model_id: "flowlet-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "anthropic", enabled: true },
  { id: "r3", virtual_model_id: "flowlet-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a2", client_protocol: "openai", enabled: true },
  { id: "r4", virtual_model_id: "flowlet-flash", upstream_model: "deepseek-v4-flash", channel_id: "deepseek", account_id: "a1", client_protocol: "responses", enabled: true },
  { id: "r5", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", enabled: true },
  { id: "r6", virtual_model_id: "flowlet-pro", upstream_model: "qwen3.8-max", channel_id: "qwen", account_id: "a1", client_protocol: "openai", enabled: true },
] as RouteCandidate[];

const channels = [
  { id: "deepseek", name: "DeepSeek", supported_protocols: ["openai", "anthropic", "responses"] },
  { id: "qwen", name: "Qwen", supported_protocols: ["openai", "anthropic", "responses"] },
] as ChannelPreset[];

describe("OverviewExposedModelsCard", () => {
  it("explains how to make aggregate models available when no account exists", () => {
    render(
      <OverviewExposedModelsCard
        routes={[]}
        accounts={[]}
        channels={channels}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("聚合模型")).toBeInTheDocument();
    expect(screen.getByText("共 2 个聚合模型")).toBeInTheDocument();
    expect(screen.getByText("添加渠道账号并配置聚合路由后，这里会显示可用状态。")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows real candidate health without exposing protocol details", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();

    render(
      <OverviewExposedModelsCard
        routes={routes}
        accounts={accounts}
        channels={channels}
        onManage={onManage}
      />,
    );

    expect(screen.getByText("2 / 2 个模型可用 · 1 / 2 个账号可用")).toBeInTheDocument();
    expect(screen.getByText("1 / 1 个模型可用 · 1 / 1 个账号可用")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI / Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Responses")).not.toBeInTheDocument();
    expect(screen.getByText("部分可用")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.queryByText("deepseek-v4-pro")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "管理模型" }));
    expect(onManage).toHaveBeenCalledOnce();
  });
});
