import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChannelBrandLogo } from "./ChannelBrandLogo";

describe("ChannelBrandLogo", () => {
  it("uses the vendored LongCat color asset", () => {
    const { container } = render(<ChannelBrandLogo channelId="longcat" name="LongCat" />);
    expect(container.querySelector('img[src="/icons/lobe/longcat-color.svg"]')).toBeInTheDocument();
  });
});
