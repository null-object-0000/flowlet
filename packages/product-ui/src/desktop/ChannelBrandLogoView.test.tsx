import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChannelBrandLogoView } from "./ChannelBrandLogoView";

describe("ChannelBrandLogoView", () => {
  it("uses the same vendored assets and themeable marks for app and demo", () => {
    const { container, rerender } = render(<ChannelBrandLogoView channelId="qwen" name="Qwen" />);
    expect(container.querySelector('img[src="/icons/lobe/qwen-color.svg"]')).toBeTruthy();

    rerender(<ChannelBrandLogoView channelId="kimi" name="Kimi" />);
    expect(container.querySelector('span > img[src="/icons/lobe/kimi-color.svg"]')).toBeTruthy();

    rerender(<ChannelBrandLogoView channelId="deepseek" name="DeepSeek" />);
    expect(container.querySelector("span > i")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();

    rerender(<ChannelBrandLogoView channelId="openrouter" name="OpenRouter" />);
    expect(container.querySelector("span > i")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
