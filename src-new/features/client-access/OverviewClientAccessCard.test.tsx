import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverviewClientAccessCard } from "./OverviewClientAccessCard";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("OverviewClientAccessCard", () => {
  it("renders and copies the four legacy access values", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    render(
      <OverviewClientAccessCard
        baseUrl="http://127.0.0.1:18640"
        bindConfig={{
          host: "127.0.0.1",
          port: 18640,
          allow_lan: false,
          default_client_token: "flowlet-local-token",
        }}
        running
      />,
    );

    expect(screen.getByText("OpenAI Base URL")).toBeInTheDocument();
    expect(screen.getByText("Anthropic Base URL")).toBeInTheDocument();
    expect(screen.getByText("健康检查地址")).toBeInTheDocument();
    expect(screen.getByText("默认客户端 Token")).toBeInTheDocument();
    expect(screen.queryByText("flowlet-local-token")).not.toBeInTheDocument();
    expect(screen.getByText("••••••••••••••••••••")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示默认客户端 Token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制OpenAI Base URL" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示默认客户端 Token" }));
    expect(screen.getByText("flowlet-local-token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏默认客户端 Token" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制默认客户端 Token（图标）" }));
    expect(writeText).toHaveBeenCalledWith("Bearer flowlet-local-token");
    writeText.mockClear();

    await user.click(screen.getByText("OpenAI Base URL"));
    expect(writeText).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "复制OpenAI Base URL" }));
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:18640/v1");
    expect(await screen.findByText("OpenAI Base URL 已复制")).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "复制健康检查地址" }));
    expect(await screen.findByText("复制失败：clipboard unavailable")).toBeInTheDocument();
  });

  it("opens the complete API access details", async () => {
    const user = userEvent.setup();
    render(
      <OverviewClientAccessCard
        baseUrl="http://127.0.0.1:18640"
        bindConfig={{ host: "127.0.0.1", port: 18640, allow_lan: false }}
        running={false}
      />,
    );

    await user.click(screen.getByRole("link", { name: "查看接入详情" }));
    expect(await screen.findByText("API 接入详情")).toBeInTheDocument();
    expect(await screen.findByText(/OpenAI-compatible/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic-compatible/)).toBeInTheDocument();
    expect(screen.getByText(/安全提示/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制OpenAI 模型列表" })).toHaveTextContent("http://127.0.0.1:18640/v1/models");

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "复制OpenAI 对话接口" }));
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:18640/v1/chat/completions");
  });
});
