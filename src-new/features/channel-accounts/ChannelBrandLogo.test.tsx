import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChannelBrandLogo } from "./ChannelBrandLogo";

describe("ChannelBrandLogo", () => {
  it("uses the legacy LongCat color avatar", () => {
    const { container } = render(<ChannelBrandLogo channelId="longcat" name="LongCat" />);
    expect(container.querySelector('path[fill="#29E154"]')).toBeInTheDocument();
  });
});
