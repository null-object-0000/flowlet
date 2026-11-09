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
  { id: "r2", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "anthropic", enabled: true },
  { id: "r3", virtual_model_id: "deepseek-v4-pro", upstream_model: "deepseek-v4-pro-0813", channel_id: "deepseek", account_id: "a2", client_protocol: "openai", enabled: true },
  { id: "r4", virtual_model_id: "deepseek-v4-flash", upstream_model: "deepseek-v4-flash", channel_id: "deepseek", account_id: "a1", client_protocol: "responses", enabled: true },
] as RouteCandidate[];

const channels = [
  { id: "deepseek", name: "DeepSeek", supported_protocols: ["openai", "anthropic", "responses"] },
] as ChannelPreset[];

describe("OverviewExposedModelsCard", () => {
  it("explains how to expose models when no route exists", () => {
    render(
      <OverviewExposedModelsCard
        routes={[]}
        accounts={[]}
        channels={channels}
        onManage={vi.fn()}
        onOpenModel={vi.fn()}
      />,
    );

    expect(screen.getByText("开放模型")).toBeInTheDocument();
    expect(screen.getByText("共 0 个模型")).toBeInTheDocument();
    expect(screen.getByText("添加渠道账号并选择开放模型后，这里会显示模型。")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows real candidate health per canonical model without exposing protocol details", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();

    render(
      <OverviewExposedModelsCard
        routes={routes}
        accounts={accounts}
        channels={channels}
        onManage={onManage}
        onOpenModel={vi.fn()}
      />,
    );

    expect(screen.getByText("开放模型")).toBeInTheDocument();
    expect(screen.getByText("共 2 个模型")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 个模型可用 · 1 / 2 个账号可用")).toBeInTheDocument();
    expect(screen.getByText("1 / 1 个模型可用 · 1 / 1 个账号可用")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI / Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Responses")).not.toBeInTheDocument();
    expect(screen.getByText("部分可用")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "管理模型" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("opens the model service page for the clicked canonical model", async () => {
    const user = userEvent.setup();
    const onOpenModel = vi.fn();

    render(
      <OverviewExposedModelsCard
        routes={routes}
        accounts={accounts}
        channels={channels}
        onManage={vi.fn()}
        onOpenModel={onOpenModel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "查看 deepseek-v4-pro 模型详情" }));
    expect(onOpenModel).toHaveBeenCalledWith("deepseek-v4-pro");
  });
});

it("counts routes only for protocols supported by the channel", () => {
  render(<OverviewExposedModelsCard
    routes={[
      { id: "ok", virtual_model_id: "gpt-6.1-sol", upstream_model: "gpt-6.1-sol", channel_id: "openai-api", account_id: "a1", client_protocol: "responses", priority: 0, enabled: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "unsupported", virtual_model_id: "gpt-6.1-sol", upstream_model: "gpt-6.1-sol-2026", channel_id: "openai-api", account_id: "a1", client_protocol: "anthropic", priority: 1, enabled: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ]}
    accounts={[{ ...accounts[0], channel_id: "openai-api" }]}
    channels={[{ id: "openai-api", name: "ChatGPT API", supported_protocols: ["openai", "responses"] } as ChannelPreset]}
    onManage={vi.fn()} onOpenModel={vi.fn()}
  />);
  expect(screen.getByText("1 / 2 个模型可用 · 1 / 1 个账号可用")).toBeInTheDocument();
});

it("hides legacy aggregate route names that are no longer canonical models", () => {
  render(
    <OverviewExposedModelsCard
      routes={[{ id: "legacy", virtual_model_id: "flowlet-pro", upstream_model: "deepseek-v4-pro", channel_id: "deepseek", account_id: "a1", client_protocol: "openai", priority: 0, enabled: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]}
      accounts={accounts}
      channels={channels}
      onManage={vi.fn()}
      onOpenModel={vi.fn()}
    />,
  );
  expect(screen.getByText("共 0 个模型")).toBeInTheDocument();
  expect(screen.queryByText("flowlet-pro")).not.toBeInTheDocument();
});
